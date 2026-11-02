const { chatCompletion } = require("./llm.js");
const { fence } = require("./skills.js");

// Small models tend to treat "the PR fixes problem X by doing Y" as a problem and a fix, so the prompt asks for a
// problem that still exists in the PR and a change the author should make.
const CHECK_SYSTEM_PROMPT = `You check a single finding from an automated review of a pull request before it is posted as a comment to the PR author. You can't see the code; don't judge whether the finding is technically correct, only whether it is worth posting.

A finding is worth posting only if it asks the author to change something that the PR doesn't do yet:
1. It names a problem that still exists in the PR's code: something wrong, missing or risky. A description of what the PR does, of a problem the PR already fixes, praise, or a confirmation that the change is correct does not count, and neither does an open question or a vague "might be an issue" without a stated problem.
2. It proposes a fix: a concrete change the author should make.

Answer with exactly one line: \`KEEP\`, or \`DROP: <short reason>\`.`;

function buildCheckPrompt(finding) {
  return `Priority: ${finding.priority}\nLocation: ${finding.path}:${finding.line}\nTitle: ${finding.title}\n\n${fence(finding.body)}`;
}

// Parses `KEEP` or `DROP: <reason>`, tolerating Markdown emphasis and surrounding text. Returns undefined if the
// answer contains neither.
function parseVerdict(content) {
  const match = /\b(KEEP|DROP)\b[\s:*-]*(.*)/i.exec(content || "");
  if (!match) return undefined;
  return { keep: match[1].toUpperCase() === "KEEP", reason: match[2].replace(/\*+$/, "").trim() };
}

// Checks every finding with an independent, minimal request (no tools, no review context) to `model`, which can be
// much smaller than the review model, and drops the findings that don't name a problem or don't propose a fix.
// The check fails open: a finding is kept if its request fails or the answer can't be parsed.
async function checkFindings(core, { endpoint, apiKey, model, findings }) {
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const results = await Promise.all(
    findings.map(async (finding) => {
      const label = `${finding.path}:${finding.line} "${finding.title}"`;
      try {
        const response = await chatCompletion(core, {
          endpoint,
          apiKey,
          model,
          messages: [
            { role: "system", content: CHECK_SYSTEM_PROMPT },
            { role: "user", content: buildCheckPrompt(finding) },
          ],
        });
        for (const key of Object.keys(usage)) usage[key] += response.usage?.[key] || 0;
        const verdict = parseVerdict(response.message.content);
        if (!verdict) {
          core.warning(`ai-review: check of ${label} gave no verdict; keeping it. Answer: ${response.message.content}`);
          return { finding, keep: true };
        }
        core.info(`ai-review: check: ${verdict.keep ? "keeping" : "dropping"} ${label}${verdict.reason && ` (${verdict.reason})`}`);
        return { finding, ...verdict };
      } catch (err) {
        core.warning(`ai-review: check of ${label} failed (${err.message}); keeping it.`);
        return { finding, keep: true };
      }
    }),
  );
  return {
    findings: results.filter((result) => result.keep).map((result) => result.finding),
    dropped: results.filter((result) => !result.keep).map(({ finding, reason }) => ({ finding, reason })),
    usage,
  };
}

module.exports = { CHECK_SYSTEM_PROMPT, buildCheckPrompt, parseVerdict, checkFindings };
