const fs = require("node:fs");
const path = require("node:path");

const PRIORITIES = [
  { priority: "blocking", label: "🔴 Blocking" },
  { priority: "should_fix", label: "🟠 Should fix" },
  { priority: "consider", label: "🟡 Consider" },
];
const PRIORITY_NAMES = PRIORITIES.map(({ priority }) => priority);

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

// Whether the finding is on a line that can take an inline comment. `commentable` maps the PR's file paths to those
// lines (see `fetchCommentableLines`); without it, nothing is posted inline.
function isInline(commentable, finding) {
  return commentable?.get(finding.path)?.has(finding.line) ?? false;
}

// Tools for staging findings during the review instead of submitting them all at once: the findings survive a review
// that doesn't finish, each one is validated on its own, and every result shows the model the current list.
// Without `commentable` (see `isInline`), the model isn't told where a finding will be posted.
function createFindingTools({ repoPath, commentable }) {
  const findings = [];
  let nextId = 1;

  function checkPath(requested) {
    const relative = nonEmptyString(requested, "path").replace(/^\.\//, "");
    if (path.isAbsolute(relative) || relative.split("/").includes("..")) {
      throw new Error(`path must be relative to the repository root: ${requested}`);
    }
    // Files deleted by the PR only exist in the diff.
    if (!commentable?.has(relative) && !fs.existsSync(path.join(repoPath, relative))) {
      throw new Error(`file not found in the PR head: ${requested}`);
    }
    return relative;
  }

  function placement(finding) {
    if (!commentable) return "";
    return isInline(commentable, finding) ? "inline comment" : "review body";
  }

  function listFindings() {
    if (findings.length === 0) return "No findings staged.";
    const entries = findings.map((finding) => {
      const where = placement(finding);
      return `- ${finding.id} [${finding.priority}] ${finding.path}:${finding.line}${where && ` (${where})`}: ${finding.title}`;
    });
    return `Staged findings:\n${entries.join("\n")}`;
  }

  function addFinding({ path: requested, line, priority, title, body }) {
    const finding = { path: checkPath(requested), line, priority, title: nonEmptyString(title, "title"), body: nonEmptyString(body, "body") };
    if (!Number.isInteger(line) || line < 1) throw new Error("line must be a positive integer");
    if (!PRIORITY_NAMES.includes(priority)) throw new Error(`priority must be one of ${PRIORITY_NAMES.join(", ")}`);
    finding.id = `F${nextId++}`;
    findings.push(finding);
    let note = "";
    if (commentable && !isInline(commentable, finding)) {
      note = ` ${finding.path}:${finding.line} isn't on a line shown in the PR diff, so it will be listed in the review body instead of as an inline comment. If the finding is about a changed line, remove it and add it again with that line.`;
    }
    return `Staged finding ${finding.id}.${note}\n\n${listFindings()}`;
  }

  function removeFinding({ id }) {
    const index = findings.findIndex((finding) => finding.id === id);
    if (index === -1) throw new Error(`no staged finding with id "${id}"`);
    findings.splice(index, 1);
    return `Removed finding ${id}.\n\n${listFindings()}`;
  }

  return {
    tools: [
      {
        name: "add_finding",
        description: "Stage a verified finding for the review. Returns the staged findings. The findings are numbered by priority and posted with the report: those on lines shown in the PR diff as inline comments, the others in the review body.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to the repository root" },
            line: { type: "integer", description: "Line in the PR head version of the file; for a range, its first line" },
            priority: { type: "string", enum: PRIORITY_NAMES },
            title: { type: "string", description: "Short title, without a number" },
            body: { type: "string", description: "Markdown: what is wrong, the concrete scenario where it fails, and the suggested fix. No heading or location link; they are added." },
          },
          required: ["path", "line", "priority", "title", "body"],
        },
        run: addFinding,
      },
      {
        name: "remove_finding",
        description: "Remove a staged finding, e.g. because it turned out to be wrong or a duplicate. Returns the remaining staged findings.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Id returned by add_finding, e.g. \"F1\"" },
          },
          required: ["id"],
        },
        run: removeFinding,
      },
    ],
    findings: () => findings.map(({ id, ...finding }) => finding),
  };
}

// Builds the review from the report and the staged findings: findings are ordered by priority and numbered, those on
// commentable lines become inline comments, and the others are added to the body under their priority section with a
// link to their location.
function renderReview({ report, findings, commentable, repoUrl, headSha }) {
  const numbered = PRIORITIES
    .flatMap(({ priority, label }) => findings.filter((finding) => finding.priority === priority).map((finding) => ({ ...finding, label })))
    .map((finding, i) => ({ ...finding, number: i + 1 }));
  const inline = numbered.filter((finding) => isInline(commentable, finding));

  const comments = inline.map((finding) => ({
    path: finding.path,
    line: finding.line,
    body: `**${finding.label}: ${finding.number}. ${finding.title}**\n\n${finding.body}`,
  }));

  const parts = [report.trim()];
  for (const { label } of PRIORITIES) {
    const section = numbered.filter((finding) => finding.label === label && !isInline(commentable, finding));
    if (section.length === 0) continue;
    parts.push(`## ${label}`);
    for (const finding of section) {
      // Anchors in the "Files changed" view only resolve to lines of the diff, so link the file at the PR head.
      const url = `${repoUrl}/blob/${headSha}/${finding.path}#L${finding.line}`;
      parts.push(`### ${finding.number}. ${finding.title}\n[\`${finding.path}:${finding.line}\`](${url})\n\n${finding.body}`);
    }
  }
  return { body: parts.filter(Boolean).join("\n\n"), comments };
}

module.exports = { createFindingTools, renderReview };
