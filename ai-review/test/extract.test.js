const assert = require("node:assert/strict");
const http = require("node:http");
const { after, before, describe, it } = require("node:test");

const { createExtractor, prepareLines, chunkLines, buildExtractPrompt, parseRanges, mergeRanges, renderRanges } = require("../extract.js");

describe("parseRanges", () => {
  it("parses ranges and single lines", () => {
    assert.deepEqual(parseRanges("12-30, 41, 55-57", [1, 100]), [[12, 30], [41, 41], [55, 57]]);
  });

  it("tolerates Markdown, words, en dashes and surrounding text", () => {
    assert.deepEqual(parseRanges("**Lines 12–14** and 20 to 22.", [1, 100]), [[12, 14], [20, 22]]);
    assert.deepEqual(parseRanges("```\n7..9\n```", [1, 100]), [[7, 9]]);
  });

  it("swaps reversed ranges and clamps them to the chunk", () => {
    assert.deepEqual(parseRanges("30-12", [1, 100]), [[12, 30]]);
    assert.deepEqual(parseRanges("90-120, 5", [50, 100]), [[90, 100]]);
  });

  it("treats NONE and only out-of-range numbers as nothing selected", () => {
    assert.deepEqual(parseRanges("NONE", [1, 100]), []);
    assert.deepEqual(parseRanges("none.", [1, 100]), []);
    assert.deepEqual(parseRanges("200-210", [1, 100]), []);
  });

  it("returns undefined without line numbers or NONE", () => {
    assert.equal(parseRanges("The timeout defaults to five seconds.", [1, 100]), undefined);
    assert.equal(parseRanges(null, [1, 100]), undefined);
  });
});

describe("prepareLines", () => {
  it("pretty-prints JSON so it has lines to select", () => {
    assert.deepEqual(prepareLines('{"a":1,"b":[2]}', "application/json"), ["{", '  "a": 1,', '  "b": [', "    2", "  ]", "}"]);
  });

  it("keeps other text, including invalid JSON, and drops a trailing newline", () => {
    assert.deepEqual(prepareLines("one\ntwo\n", "text/plain"), ["one", "two"]);
    assert.deepEqual(prepareLines("{not json", "application/json"), ["{not json"]);
  });
});

describe("chunkLines", () => {
  it("splits at line boundaries", () => {
    const lines = Array.from({ length: 10 }, () => "x".repeat(92));
    // 100 bytes per line with the line number overhead.
    assert.deepEqual(chunkLines(lines, 300), [[1, 3], [4, 6], [7, 9], [10, 10]]);
    assert.deepEqual(chunkLines([], 300), []);
  });

  it("puts a line longer than the chunk size into a chunk of its own", () => {
    assert.deepEqual(chunkLines(["a", "x".repeat(1000), "b"], 300), [[1, 1], [2, 2], [3, 3]]);
  });
});

describe("buildExtractPrompt", () => {
  it("numbers the lines of the chunk and cuts long lines", () => {
    const prompt = buildExtractPrompt("default timeout?", ["a", "b", "c", "x".repeat(600)], [2, 4]);
    assert.ok(prompt.startsWith("Question: default timeout?\n\nLines 2-4 of the document:\n\n2\tb\n3\tc\n4\txxx"));
    assert.ok(prompt.endsWith("x…"));
  });
});

describe("mergeRanges and renderRanges", () => {
  it("pads, sorts and merges ranges", () => {
    assert.deepEqual(mergeRanges([[20, 22], [2, 3], [8, 9]], 23, 2), [[1, 11], [18, 23]]);
    assert.deepEqual(mergeRanges([[5, 5]], 100, 0), [[5, 5]]);
  });

  it("copies the lines with their numbers", () => {
    assert.equal(renderRanges(["a", "b", "c", "d", "e"], [[1, 2], [4, 4]]), "1\ta\n2\tb\n…\n4\td");
  });
});

describe("createExtractor", () => {
  // Answers based on the first line number of the chunk in the prompt; a missing entry makes the request fail.
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
        const first = Number(/^Lines (\d+)-/m.exec(body.messages[1].content)[1]);
        const answer = answers.get(first);
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

  // 40 lines of 92 characters (100 bytes in the chunking), so chunks of 1000 bytes hold 10 lines each.
  const text = Array.from({ length: 40 }, (_, i) => `line ${String(i + 1).padStart(2, "0")} ${"x".repeat(84)}`).join("\n");
  const input = { text, contentType: "text/plain", question: "where is line 15?", url: "https://docs.example/page" };

  function create(options = {}) {
    return createExtractor(core, { endpoint, apiKey: "key", model: "small-model", chunkBytes: 1000, ...options });
  }

  it("sends one tool-less request per chunk and returns the selected lines verbatim", async () => {
    answers.clear();
    answers.set(1, "NONE");
    answers.set(11, "15");
    answers.set(21, "NONE");
    answers.set(31, "39-40");
    requests.length = 0;
    const extractor = create();
    const output = await extractor.extract(input);
    assert.equal(requests.length, 4);
    for (const request of requests) {
      assert.equal(request.model, "small-model");
      assert.equal(request.tools, undefined);
      assert.equal(request.messages[0].role, "system");
      assert.match(request.messages[1].content, /^Question: where is line 15\?/);
    }
    const lines = text.split("\n");
    const expected = [13, 14, 15, 16, 17].map((n) => `${n}\t${lines[n - 1]}`).join("\n") + "\n…\n" + [37, 38, 39, 40].map((n) => `${n}\t${lines[n - 1]}`).join("\n");
    assert.equal(output, `Extract for the question "where is line 15?": lines 13-17, 37-40 of 40 lines, ${Buffer.byteLength(text)} bytes, selected by a smaller model. If something is missing, ask a more specific question.\n\n${expected}`);
    assert.deepEqual(extractor.usage, { prompt_tokens: 400, completion_tokens: 20, total_tokens: 420 });
    assert.ok(log.info.some((msg) => msg.includes('extract: https://docs.example/page "where is line 15?": lines 13-17, 37-40 of 40')));
  });

  it("returns the first lines if nothing matched", async () => {
    for (const first of [1, 11, 21, 31]) answers.set(first, "NONE");
    const output = await create().extract(input);
    assert.match(output, /^No lines matched the question "where is line 15\?" \(40 lines, \d+ bytes\)\. Ask a different question/);
    assert.match(output, /\n\n1\tline 01 x+\n2\tline 02/);
    assert.match(output, /30\tline 30 x+$/);
  });

  it("only searches the start of a huge response and says so", async () => {
    requests.length = 0;
    // 2000 bytes hold 21 complete lines of 93 bytes (with the newline); the cut is at the end of line 21.
    const output = await create({ maxInputBytes: 2000 }).extract(input);
    assert.equal(requests.length, 3);
    assert.match(requests.at(-1).messages[1].content, /Lines 21-21 of the document:\n\n21\tline 21 x+$/);
    assert.match(output, /Only the first 2000 bytes of the response were searched/);
  });

  it("caps the extract", async () => {
    answers.set(1, "1-10");
    const output = await create({ maxBytes: 500 }).extract(input);
    assert.match(output, /\[output truncated: exceeded 500 bytes\]$/);
  });

  it("fails open if a request fails or gives no line numbers", async () => {
    answers.set(1, "NONE");
    answers.delete(11);
    log.warning.length = 0;
    assert.equal(await create().extract(input), undefined);
    answers.set(11, "Line fifteen is the one you want.");
    assert.equal(await create().extract(input), undefined);
    assert.equal(log.warning.length, 2);
    assert.match(log.warning[0], /extract: https:\/\/docs.example\/page "where is line 15\?" failed \(request failed with status 500/);
    assert.match(log.warning[1], /no line ranges in the answer for lines 11-20/);
  });
});
