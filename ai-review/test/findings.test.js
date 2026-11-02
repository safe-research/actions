const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const { createFindingTools, renderReview } = require("../findings.js");

describe("finding tools", () => {
  let repoPath;
  const commentable = new Map([["src/a.js", new Set([3, 4])], ["deleted.js", new Set()]]);

  before(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-review-findings-"));
    fs.mkdirSync(path.join(repoPath, "src"));
    fs.writeFileSync(path.join(repoPath, "src/a.js"), "a\n");
    fs.writeFileSync(path.join(repoPath, "b.js"), "b\n");
  });
  after(() => fs.rmSync(repoPath, { recursive: true, force: true }));

  const finding = (overrides = {}) => ({ path: "src/a.js", line: 3, priority: "blocking", title: "Bug", body: "Breaks.", ...overrides });
  const setup = (options = {}) => {
    const { tools, findings } = createFindingTools({ repoPath, commentable, ...options });
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.run]));
    return { add: byName.add_finding, remove: byName.remove_finding, findings };
  };

  it("stages findings and lists them with their placement", () => {
    const { add, findings } = setup();

    assert.equal(add(finding()), "Staged finding F1.\n\nStaged findings:\n- F1 [blocking] src/a.js:3 (inline comment): Bug");
    const second = add(finding({ path: "./b.js", line: 9, priority: "consider", title: "Caller" }));

    assert.match(second, /^Staged finding F2\. b\.js:9 isn't on a line shown in the PR diff, so it will be listed in the review body/);
    assert.ok(second.endsWith("- F1 [blocking] src/a.js:3 (inline comment): Bug\n- F2 [consider] b.js:9 (review body): Caller"));
    assert.deepEqual(findings(), [
      { path: "src/a.js", line: 3, priority: "blocking", title: "Bug", body: "Breaks." },
      { path: "b.js", line: 9, priority: "consider", title: "Caller", body: "Breaks." },
    ]);
  });

  it("removes findings by id without reusing ids", () => {
    const { add, remove, findings } = setup();
    add(finding());
    add(finding({ title: "Other" }));

    assert.equal(remove({ id: "F1" }), "Removed finding F1.\n\nStaged findings:\n- F2 [blocking] src/a.js:3 (inline comment): Other");
    assert.match(add(finding({ title: "Third" })), /^Staged finding F3\./);
    assert.deepEqual(findings().map((f) => f.title), ["Other", "Third"]);
    assert.throws(() => remove({ id: "F1" }), /no staged finding with id "F1"/);
  });

  it("rejects invalid findings", () => {
    const { add, findings } = setup();
    assert.throws(() => add(finding({ path: "../etc/passwd" })), /relative to the repository root/);
    assert.throws(() => add(finding({ path: "/etc/passwd" })), /relative to the repository root/);
    assert.throws(() => add(finding({ path: "missing.js" })), /file not found in the PR head: missing.js/);
    assert.throws(() => add(finding({ line: 0 })), /line must be a positive integer/);
    assert.throws(() => add(finding({ line: "3" })), /line must be a positive integer/);
    assert.throws(() => add(finding({ priority: "urgent" })), /priority must be one of blocking, should_fix, consider/);
    assert.throws(() => add(finding({ title: " " })), /title must be a non-empty string/);
    assert.throws(() => add(finding({ body: undefined })), /body must be a non-empty string/);
    assert.deepEqual(findings(), []);
  });

  it("accepts files that only exist in the diff", () => {
    const { add } = setup();
    assert.match(add(finding({ path: "deleted.js", line: 1 })), /^Staged finding F1\. deleted\.js:1 isn't on a line shown/);
  });

  it("doesn't mention the placement if the changed lines are unknown", () => {
    const { add } = setup({ commentable: undefined });
    assert.equal(add(finding({ path: "b.js" })), "Staged finding F1.\n\nStaged findings:\n- F1 [blocking] b.js:3: Bug");
  });
});

describe("renderReview", () => {
  const repoUrl = "https://github.com/acme/widgets";
  const headSha = "b".repeat(40);
  const commentable = new Map([["a.js", new Set([3])]]);
  const finding = (priority, title, overrides = {}) => ({ path: "b.js", line: 7, priority, title, body: `${title} body`, ...overrides });

  it("numbers findings by priority, posts commentable ones inline and the rest in the body", () => {
    const { body, comments } = renderReview({
      report: "# Review: Add feature (#42)\n\nOne blocking issue.\n",
      findings: [
        finding("consider", "Nit"),
        finding("blocking", "Bug", { path: "a.js", line: 3 }),
        finding("should_fix", "Missing test"),
        finding("blocking", "Broken caller"),
      ],
      commentable,
      repoUrl,
      headSha,
    });

    assert.deepEqual(comments, [{ path: "a.js", line: 3, body: "**🔴 Blocking: 1. Bug**\n\nBug body" }]);
    assert.equal(body, [
      "# Review: Add feature (#42)\n\nOne blocking issue.",
      "## 🔴 Blocking",
      `### 2. Broken caller\n[\`b.js:7\`](${repoUrl}/blob/${headSha}/b.js#L7)\n\nBroken caller body`,
      "## 🟠 Should fix",
      `### 3. Missing test\n[\`b.js:7\`](${repoUrl}/blob/${headSha}/b.js#L7)\n\nMissing test body`,
      "## 🟡 Consider",
      `### 4. Nit\n[\`b.js:7\`](${repoUrl}/blob/${headSha}/b.js#L7)\n\nNit body`,
    ].join("\n\n"));
  });

  it("leaves inline findings out of the body", () => {
    const { body, comments } = renderReview({
      report: "Report",
      findings: [finding("blocking", "A", { path: "a.js", line: 3 }), finding("consider", "B", { path: "a.js", line: 3 })],
      commentable,
      repoUrl,
      headSha,
    });
    assert.equal(body, "Report");
    assert.deepEqual(comments.map((c) => c.body.split("\n")[0]), ["**🔴 Blocking: 1. A**", "**🟡 Consider: 2. B**"]);
  });

  it("puts every finding in the body if the changed lines are unknown", () => {
    const { body, comments } = renderReview({
      report: "Report",
      findings: [finding("blocking", "A", { path: "a.js", line: 3 })],
      commentable: undefined,
      repoUrl,
      headSha,
    });
    assert.deepEqual(comments, []);
    assert.equal(body, `Report\n\n## 🔴 Blocking\n\n### 1. A\n[\`a.js:3\`](${repoUrl}/blob/${headSha}/a.js#L3)\n\nA body`);
  });

  it("returns just the report without findings", () => {
    assert.deepEqual(renderReview({ report: "No findings.", findings: [], commentable, repoUrl, headSha }), { body: "No findings.", comments: [] });
  });
});
