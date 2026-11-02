const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { describe, it } = require("node:test");

const { fillDiffAnchors, parseCommentableLines, fetchCommentableLines, postReview } = require("../github.js");

const PR_URL = "https://github.com/acme/widgets/pull/42";

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

describe("fillDiffAnchors", () => {
  it("replaces the hash placeholder with the SHA-256 of the path in the link text", () => {
    const report = `[\`src/app.js:42-48\`](${PR_URL}/files#diff-<file hash>R42-R48)`;
    assert.equal(fillDiffAnchors(report, PR_URL), `[\`src/app.js:42-48\`](${PR_URL}/files#diff-${sha256("src/app.js")}R42-R48)`);
  });

  it("replaces a wrong hash and keeps left-side and single-line anchors", () => {
    const report = [
      `[\`a.js:3\`](${PR_URL}/files#diff-0123abcdL3)`,
      `[b.js](${PR_URL}/files#diff-deadbeef)`,
      `[\`./c.js:1-2\`](${PR_URL}/files#diff-R1-R2)`,
    ].join("\n");
    assert.equal(fillDiffAnchors(report, PR_URL), [
      `[\`a.js:3\`](${PR_URL}/files#diff-${sha256("a.js")}L3)`,
      `[b.js](${PR_URL}/files#diff-${sha256("b.js")})`,
      `[\`./c.js:1-2\`](${PR_URL}/files#diff-${sha256("c.js")}R1-R2)`,
    ].join("\n"));
  });

  it("rewrites every link but leaves other links and text unchanged", () => {
    const blob = `[\`lib/x.js:5\`](https://github.com/acme/widgets/blob/${"b".repeat(40)}/lib/x.js#L5)`;
    const other = `[\`a.js:1\`](https://github.com/acme/widgets/pull/43/files#diff-<file hash>R1)`;
    const report = `# Review\n\n${blob}\n\n[\`a.js:1\`](${PR_URL}/files#diff-<file hash>R1) and [\`b.js:2\`](${PR_URL}/files#diff-<file hash>R2)\n\n${other}`;
    assert.equal(
      fillDiffAnchors(report, PR_URL),
      `# Review\n\n${blob}\n\n[\`a.js:1\`](${PR_URL}/files#diff-${sha256("a.js")}R1) and [\`b.js:2\`](${PR_URL}/files#diff-${sha256("b.js")}R2)\n\n${other}`,
    );
  });
});

describe("parseCommentableLines", () => {
  it("returns the added and context lines of the new version", () => {
    const patch = [
      "@@ -1,4 +1,5 @@",
      " a",
      "-b",
      "+B",
      "+C",
      " d",
      "\\ No newline at end of file",
      "@@ -20,2 +21,1 @@ function f() {",
      "-x",
      " y",
    ].join("\n");
    assert.deepEqual([...parseCommentableLines(patch)], [1, 2, 3, 4, 21]);
  });

  it("handles single-line hunk headers and empty patches", () => {
    assert.deepEqual([...parseCommentableLines("@@ -0,0 +1 @@\n+only")], [1]);
    assert.deepEqual([...parseCommentableLines("")], []);
  });
});

describe("fetchCommentableLines", () => {
  it("pages through the PR's files", async () => {
    const pages = [
      Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.js`, patch: "@@ -1 +1 @@\n+x" })),
      [{ filename: "image.png" }, { filename: "last.js", patch: "@@ -1,0 +5,2 @@\n+a\n+b" }],
    ];
    const calls = [];
    const github = { rest: { pulls: { listFiles: async (params) => (calls.push(params), { data: pages[params.page - 1] }) } } };

    const commentable = await fetchCommentableLines(github, { owner: "acme", repo: "widgets", prNumber: 42 });

    assert.deepEqual(calls.map((c) => c.page), [1, 2]);
    assert.deepEqual(calls[0], { owner: "acme", repo: "widgets", pull_number: 42, per_page: 100, page: 1 });
    assert.equal(commentable.size, 102);
    assert.deepEqual([...commentable.get("f0.js")], [1]);
    assert.deepEqual([...commentable.get("image.png")], []);
    assert.deepEqual([...commentable.get("last.js")], [5, 6]);
  });
});

describe("postReview", () => {
  const core = { warning() {} };
  const params = { owner: "acme", repo: "widgets", prNumber: 42, body: "report" };

  it("posts the inline comments on the right side", async () => {
    const reviews = [];
    const github = { rest: { pulls: { createReview: async (review) => reviews.push(review) } } };

    await postReview(github, core, { ...params, comments: [{ path: "a.js", line: 3, body: "Bug" }] });

    assert.deepEqual(reviews, [{
      owner: "acme", repo: "widgets", pull_number: 42, body: "report", event: "COMMENT",
      comments: [{ path: "a.js", line: 3, body: "Bug", side: "RIGHT" }],
    }]);
  });

  it("folds the comments into the body if posting them fails", async () => {
    const reviews = [];
    const github = { rest: { pulls: { createReview: async (review) => {
      reviews.push(review);
      if (review.comments?.length) throw new Error("Unprocessable Entity");
    } } } };

    await postReview(github, core, { ...params, comments: [{ path: "a.js", line: 3, body: "Bug" }] });

    assert.equal(reviews.length, 2);
    assert.equal(reviews[1].body, "report\n\n---\n\n**a.js:3**\nBug");
    assert.equal(reviews[1].comments, undefined);
  });
});
