const assert = require("node:assert/strict");
const http = require("node:http");
const { after, before, describe, it } = require("node:test");

const { buildCheckPrompt, parseVerdict, checkFindings } = require("../check.js");

const PRAISE = { path: "vitest.config.ts", line: 32, priority: "blocking", title: "Fix localStorage issue", body: "The PR correctly addresses the issue. The change is minimal and surgical." };
const BUG = { path: "src/app.js", line: 10, priority: "should_fix", title: "Off-by-one in loop", body: "`i <= n` reads past the end. Use `i < n`." };

describe("parseVerdict", () => {
  it("parses KEEP and DROP with a reason", () => {
    assert.deepEqual(parseVerdict("KEEP"), { keep: true, reason: "" });
    assert.deepEqual(parseVerdict("DROP: only praises the change"), { keep: false, reason: "only praises the change" });
  });

  it("tolerates case, emphasis and surrounding text", () => {
    assert.deepEqual(parseVerdict("**DROP** - no fix proposed"), { keep: false, reason: "no fix proposed" });
    assert.deepEqual(parseVerdict("Verdict: keep\n"), { keep: true, reason: "" });
  });

  it("returns undefined without a verdict", () => {
    assert.equal(parseVerdict("I am not sure."), undefined);
    assert.equal(parseVerdict(null), undefined);
  });
});

describe("buildCheckPrompt", () => {
  it("includes the finding and fences its body", () => {
    const prompt = buildCheckPrompt({ ...BUG, body: "Use:\n```js\ni < n\n```" });
    assert.ok(prompt.startsWith("Priority: should_fix\nLocation: src/app.js:10\nTitle: Off-by-one in loop\n\n````text\nUse:\n```js"));
    assert.ok(prompt.endsWith("```\n````"));
  });
});

describe("checkFindings", () => {
  // Answers each request based on the finding's title in the prompt.
  const answers = new Map();
  const requests = [];
  let server, endpoint;
  const log = { info: [], warning: [] };
  const core = { debug() {}, info: (msg) => log.info.push(msg), warning: (msg) => log.warning.push(msg) };

  before(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw);
        requests.push(body);
        const title = /^Title: (.*)$/m.exec(body.messages[1].content)[1];
        const answer = answers.get(title);
        if (answer === undefined) return res.writeHead(500).end("boom");
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: answer } }],
          usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
        }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${server.address().port}/v1/`;
  });

  after(() => server.close());

  it("drops findings the check model rejects and keeps the others", async () => {
    answers.set(PRAISE.title, "DROP: confirms the change is correct, no problem");
    answers.set(BUG.title, "KEEP");
    requests.length = 0;
    const result = await checkFindings(core, { endpoint, apiKey: "key", model: "small-model", findings: [PRAISE, BUG] });
    assert.deepEqual(result.findings, [BUG]);
    assert.deepEqual(result.dropped, [{ finding: PRAISE, reason: "confirms the change is correct, no problem" }]);
    assert.deepEqual(result.usage, { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 });
    // One independent request per finding, without tools.
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.model, "small-model");
      assert.equal(request.tools, undefined);
      assert.equal(request.messages.length, 2);
      assert.equal(request.messages[0].role, "system");
    }
    assert.ok(log.info.some((msg) => msg.includes('dropping vitest.config.ts:32 "Fix localStorage issue" (confirms the change is correct, no problem)')));
  });

  it("keeps findings if the request fails or the answer has no verdict", async () => {
    answers.delete(PRAISE.title);
    answers.set(BUG.title, "Looks fine to me.");
    log.warning.length = 0;
    const result = await checkFindings(core, { endpoint, apiKey: "key", model: "small-model", findings: [PRAISE, BUG] });
    assert.deepEqual(result.findings, [PRAISE, BUG]);
    assert.deepEqual(result.dropped, []);
    assert.equal(log.warning.length, 2);
    assert.match(log.warning.join("\n"), /check of vitest.config.ts:32 "Fix localStorage issue" failed/);
    assert.match(log.warning.join("\n"), /gave no verdict; keeping it/);
  });

  it("does nothing without findings", async () => {
    requests.length = 0;
    const result = await checkFindings(core, { endpoint, apiKey: "key", model: "small-model", findings: [] });
    assert.deepEqual(result, { findings: [], dropped: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    assert.equal(requests.length, 0);
  });
});
