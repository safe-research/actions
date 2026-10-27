async function fetchPullRequest(github, { owner, repo, prNumber }) {
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const { data: diff } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: { format: "diff" },
  });
  return { pr, diff };
}

async function fetchFiles(github, core, { owner, repo, ref, paths }) {
  const files = [];
  for (const path of paths) {
    try {
      const { data } = await github.rest.repos.getContent({ owner, repo, path, ref });
      if (typeof data.content === "string") {
        core.debug(`Added ${path} to context`)
        files.push({ path, content: Buffer.from(data.content, "base64").toString("utf8") });
      }
    } catch {
      // requested file may not exist, be binary, or exceed the API size limit
    }
  }
  return files;
}

async function postReview(github, core, { owner, repo, prNumber, body, comments }) {
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

module.exports = { fetchPullRequest, fetchFiles, postReview };
