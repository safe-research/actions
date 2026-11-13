const assert = require("node:assert/strict");
const http = require("node:http");
const { after, before, beforeEach, describe, it } = require("node:test");

const { runAgent } = require("../agent.js");

const core = { debug() {}, info() {}, warning() {} };

function toolCall(id, name, args) {
  return { id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } };
}

function assistant({ content = null, toolCalls } = {}) {
  return { role: "assistant", content, ...(toolCalls && { tool_calls: toolCalls }) };
}

// Fake chat completions endpoint. Each request is answered by the next scripted handler, which receives the
// parsed request body and returns either an assistant message or `{ status, body }` for an error response.
function createFakeEndpoint() {
  let script = [];
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push({ url: req.url, authorization: req.headers.authorization, body });
      const handler = script.shift();
      const reply = handler ? handler(body) : { status: 500, body: "no scripted response" };
      if (reply.status) {
        res.writeHead(reply.status).end(reply.body);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        choices: [{ index: 0, message: reply, finish_reason: reply.tool_calls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
  });
  return {
    requests,
    script: (...handlers) => { script = handlers; requests.length = 0; },
    start: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/v1/`))),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe("runAgent", () => {
  const fake = createFakeEndpoint();
  let endpoint, toolRuns;

  const stubTools = [
    {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      run: async ({ path }) => { toolRuns.push(path); return `contents of ${path}`; },
    },
    {
      name: "fail",
      description: "Always fails",
      parameters: { type: "object", properties: {} },
      run: async () => { throw new Error("boom"); },
    },
    {
      name: "big",
      description: "Returns a lot of output",
      parameters: { type: "object", properties: {} },
      run: async () => "x".repeat(5000),
    },
  ];

  const run = (options = {}) => runAgent(core, {
    endpoint,
    apiKey: "test-key",
    model: "primary",
    systemPrompt: "system",
    userPrompt: "Review PR #1",
    tools: stubTools,
    ...options,
  });

  before(async () => { endpoint = await fake.start(); });
  after(() => fake.stop());
  beforeEach(() => { toolRuns = []; });

  it("runs tool calls and returns the submitted report", async () => {
    fake.script(
      () => assistant({ toolCalls: [toolCall("c1", "read_file", { path: "a.js" }), toolCall("c2", "read_file", { path: "b.js" })] }),
      () => assistant({ toolCalls: [toolCall("c3", "submit_review", { report: "## Findings\nNone." })] }),
    );

    const result = await run();

    assert.deepEqual(result, {
      report: "## Findings\nNone.",
      turns: 2,
      model: "primary",
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    });
    assert.deepEqual(toolRuns, ["a.js", "b.js"]);

    const [first, second] = fake.requests;
    assert.equal(first.url, "/v1/chat/completions");
    assert.equal(first.authorization, "Bearer test-key");
    assert.equal(first.body.model, "primary");
    assert.deepEqual(first.body.messages, [
      { role: "system", content: "system" },
      { role: "user", content: "Review PR #1" },
    ]);
    assert.deepEqual(first.body.tools.map((tool) => tool.function.name), ["read_file", "fail", "big", "submit_review"]);
    assert.deepEqual(first.body.tools[0], { type: "function", function: { name: "read_file", description: stubTools[0].description, parameters: stubTools[0].parameters } });
    assert.deepEqual(second.body.messages.slice(2), [
      assistant({ toolCalls: [toolCall("c1", "read_file", { path: "a.js" }), toolCall("c2", "read_file", { path: "b.js" })] }),
      { role: "tool", tool_call_id: "c1", content: "contents of a.js" },
      { role: "tool", tool_call_id: "c2", content: "contents of b.js" },
    ]);
  });

  it("sends provider-specific message fields back unchanged", async () => {
    const message = { ...assistant({ toolCalls: [toolCall("c1", "read_file", { path: "a.js" })] }), extra_content: { google: { thought_signature: "sig" } } };
    fake.script(
      () => message,
      () => assistant({ toolCalls: [toolCall("c2", "submit_review", { report: "done" })] }),
    );

    await run();

    assert.deepEqual(fake.requests[1].body.messages[2], message);
  });

  it("returns tool errors, unknown tools and invalid arguments to the model", async () => {
    fake.script(
      () => assistant({ toolCalls: [
        toolCall("c1", "fail", {}),
        toolCall("c2", "rm_rf", {}),
        toolCall("c3", "read_file", "{not json"),
        toolCall("c4", "submit_review", { report: "" }),
      ] }),
      () => assistant({ toolCalls: [toolCall("c5", "submit_review", { report: "ok" })] }),
    );

    const { report } = await run();

    assert.equal(report, "ok");
    const toolMessages = fake.requests[1].body.messages.filter((m) => m.role === "tool");
    assert.equal(toolMessages[0].content, "Error: boom");
    assert.equal(toolMessages[1].content, 'Error: unknown tool "rm_rf"');
    assert.match(toolMessages[2].content, /^Error: .*JSON/);
    assert.equal(toolMessages[3].content, "Error: report must be a non-empty string");
  });

  it("caps tool output", async () => {
    fake.script(
      () => assistant({ toolCalls: [toolCall("c1", "big", {})] }),
      () => assistant({ toolCalls: [toolCall("c2", "submit_review", { report: "ok" })] }),
    );

    await run({ maxToolOutputBytes: 100 });

    const toolMessage = fake.requests[1].body.messages.find((m) => m.role === "tool");
    assert.match(toolMessage.content, /\[output truncated: exceeded 100 bytes\]$/);
    assert.ok(Buffer.byteLength(toolMessage.content) < 150);
  });

  it("uses a plain-text answer as the report", async () => {
    fake.script(
      () => assistant({ toolCalls: [toolCall("c1", "read_file", { path: "a.js" })] }),
      () => assistant({ content: "## Findings\nPlain text." }),
    );

    const { report, turns } = await run();

    assert.equal(report, "## Findings\nPlain text.");
    assert.equal(turns, 2);
  });

  it("nudges the model when it answers with neither text nor tool calls", async () => {
    fake.script(
      () => assistant({ content: "  " }),
      () => assistant({ toolCalls: [toolCall("c1", "submit_review", { report: "ok" })] }),
    );

    const { report } = await run();

    assert.equal(report, "ok");
    assert.equal(fake.requests[1].body.messages.at(-1).role, "user");
  });

  it("asks once more with only submit_review after reaching the turn limit", async () => {
    const readAgain = () => assistant({ toolCalls: [toolCall("c", "read_file", { path: "a.js" })] });
    fake.script(
      readAgain,
      readAgain,
      () => assistant({ toolCalls: [toolCall("c9", "submit_review", { report: "partial" })] }),
    );

    const { report, turns } = await run({ maxTurns: 2 });

    assert.equal(report, "partial");
    assert.equal(turns, 3);
    assert.equal(fake.requests.length, 3);
    assert.deepEqual(fake.requests[2].body.tools.map((tool) => tool.function.name), ["submit_review"]);
    assert.match(fake.requests[2].body.messages.at(-1).content, /turn limit/);
  });

  it("fails if nothing is submitted after the turn limit", async () => {
    const readAgain = () => assistant({ toolCalls: [toolCall("c", "read_file", { path: "a.js" })] });
    fake.script(readAgain, readAgain);

    await assert.rejects(run({ maxTurns: 1 }), /no review was submitted within 1 turns/);
  });

  it("continues the conversation on the fallback model after a failure", async () => {
    fake.script(
      () => assistant({ toolCalls: [toolCall("c1", "read_file", { path: "a.js" })] }),
      () => ({ status: 503, body: "overloaded" }),
      () => assistant({ toolCalls: [toolCall("c2", "read_file", { path: "b.js" })] }),
      () => assistant({ toolCalls: [toolCall("c3", "submit_review", { report: "ok" })] }),
    );

    const result = await run({ fallbackModel: "fallback" });

    assert.equal(result.report, "ok");
    assert.equal(result.model, "fallback");
    assert.deepEqual(fake.requests.map((r) => r.body.model), ["primary", "primary", "fallback", "fallback"]);
    // the retried request carries the same conversation
    assert.deepEqual(fake.requests[2].body.messages, fake.requests[1].body.messages);
  });

  it("throws if the fallback model fails as well", async () => {
    fake.script(
      () => ({ status: 500, body: "primary down" }),
      () => ({ status: 500, body: "fallback down" }),
    );

    await assert.rejects(run({ fallbackModel: "fallback" }), /status 500: fallback down/);
  });

  it("throws without retrying if no fallback model is configured", async () => {
    fake.script(() => ({ status: 400, body: "bad request" }));

    await assert.rejects(run(), /status 400: bad request/);
    assert.equal(fake.requests.length, 1);
  });

  it("logs progress as info and only the details as debug", async () => {
    fake.script(
      () => assistant({ toolCalls: [toolCall("c1", "read_file", { path: "a.js" }), toolCall("c2", "fail", {})] }),
      () => assistant({ toolCalls: [toolCall("c3", "submit_review", { report: "Done." })] }),
    );
    const logs = { info: [], debug: [] };
    const recordingCore = { info: (m) => logs.info.push(m), debug: (m) => logs.debug.push(m), warning() {} };
    await runAgent(recordingCore, { endpoint, apiKey: "k", model: "primary", systemPrompt: "s", userPrompt: "u", tools: stubTools });
    assert.deepEqual(logs.info, [
      "ai-review: turn 1/40 (primary): 2 tool call(s), 10 prompt + 5 completion tokens (15 total so far)",
      'ai-review: turn 1: read_file({"path":"a.js"}) -> 16 bytes',
      "ai-review: turn 1: fail({}) -> Error: boom",
      "ai-review: turn 2/40 (primary): 1 tool call(s), 10 prompt + 5 completion tokens (30 total so far)",
      "ai-review: turn 2: review submitted (5 bytes)",
    ]);
    // Debug adds the raw responses and the full tool output; the one-line error is already complete in the info log.
    assert.equal(logs.debug.length, 3);
    assert.match(logs.debug[0], /^ai-review: raw response from model "primary" \(status 200\): /);
    assert.equal(logs.debug[1], "contents of a.js");
    assert.match(logs.debug[2], /^ai-review: raw response from model "primary" \(status 200\): /);
  });

  it("truncates long tool arguments in the progress log", async () => {
    fake.script(
      () => assistant({ toolCalls: [toolCall("c1", "read_file", { path: "p".repeat(500) })] }),
      () => assistant({ toolCalls: [toolCall("c2", "submit_review", { report: "Done." })] }),
    );
    const info = [];
    await runAgent({ ...core, info: (m) => info.push(m) }, { endpoint, apiKey: "k", model: "primary", systemPrompt: "s", userPrompt: "u", tools: stubTools });
    const line = info.find((m) => m.includes("read_file("));
    assert.equal(line, `ai-review: turn 1: read_file(${'{"path":"'}${"p".repeat(191)}…) -> ${Buffer.byteLength(`contents of ${"p".repeat(500)}`)} bytes`);
  });

  it("rejects tools named submit_review", async () => {
    await assert.rejects(run({ tools: [{ ...stubTools[0], name: "submit_review" }] }), /reserved/);
  });
});
