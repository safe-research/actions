const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { describe, it } = require("node:test");

const { fillDiffAnchors } = require("../github.js");

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
