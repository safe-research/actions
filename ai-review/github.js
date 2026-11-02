const crypto = require("node:crypto");

async function fetchPullRequest(github, { owner, repo, prNumber }) {
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
  return pr;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The model can't compute SHA-256, so it can't build the anchors of the PR's "Files changed" view
// (`<PR URL>/files#diff-<sha256 of path>R<start>-R<end>`). This fills them in from the path in the link text, e.g.
// [`src/a.js:42-48`](<PR URL>/files#diff-<file hash>R42-R48). Whatever the model put in place of the hash is replaced;
// the line part is kept.
function fillDiffAnchors(report, prUrl) {
  const filesUrl = `${prUrl.replace(/\/+$/, "")}/files`;
  const link = new RegExp(
    // link text (group 1): optional backticks around the path (group 2) and an optional `:lines` suffix
    "(\\[`?([^`\\]:\\s]+)(?::[^`\\]]*)?`?\\])" +
    // URL: the PR's files view, then a lazily matched hash placeholder and an optional line range (group 3)
    `\\(${escapeRegExp(filesUrl)}#diff-[^)]*?([LR]\\d+(?:-[LR]\\d+)?)?\\)`,
    "g",
  );
  return report.replace(link, (_match, text, filePath, lines = "") => {
    const hash = crypto.createHash("sha256").update(filePath.replace(/^\.\//, "")).digest("hex");
    return `${text}(${filesUrl}#diff-${hash}${lines})`;
  });
}

// Line numbers of the new file version that a unified diff patch shows (added and context lines). Review comments on
// the RIGHT side can only be placed on these lines.
function parseCommentableLines(patch) {
  const lines = new Set();
  let line = 0;
  for (const row of patch.split("\n")) {
    // Hunk header `@@ -a,b +c,d @@`: the new version's lines of this hunk start at c (group 1).
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      line = parseInt(hunk[1]);
    } else if (line > 0 && (row.startsWith("+") || row.startsWith(" "))) {
      lines.add(line++);
    }
    // `-` lines only exist in the old version and `\ No newline at end of file` in neither.
  }
  return lines;
}

const MAX_FILE_PAGES = 30; // the API lists at most 3000 files

// Maps each file path of the PR to the lines that can take an inline comment. Files without a patch (binary or too
// large a diff) have no commentable lines.
async function fetchCommentableLines(github, { owner, repo, prNumber }) {
  const commentable = new Map();
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const { data: files } = await github.rest.pulls.listFiles({ owner, repo, pull_number: prNumber, per_page: 100, page });
    for (const file of files) {
      commentable.set(file.filename, file.patch ? parseCommentableLines(file.patch) : new Set());
    }
    if (files.length < 100) break;
  }
  return commentable;
}

async function postReview(github, core, { owner, repo, prNumber, body, comments = [] }) {
  const inlineComments = comments.map((c) => ({ path: c.path, line: c.line, body: c.body, side: "RIGHT" }));

  try {
    await github.rest.pulls.createReview({ owner, repo, pull_number: prNumber, body, event: "COMMENT", comments: inlineComments });
  } catch (err) {
    core.warning(`ai-review: failed to post review with inline comments (${err.message}); folding them into the review body instead.`);
    const foldedComments = inlineComments.map((c) => `**${c.path}:${c.line}**\n${c.body}`).join("\n\n");
    const foldedBody = foldedComments ? `${body}\n\n---\n\n${foldedComments}` : body;
    await github.rest.pulls.createReview({ owner, repo, pull_number: prNumber, body: foldedBody, event: "COMMENT" });
  }
}

module.exports = { fetchPullRequest, fillDiffAnchors, parseCommentableLines, fetchCommentableLines, postReview };
