const { runAgent, DEFAULT_MAX_TURNS } = require("./agent.js");
const { checkFindings } = require("./check.js");
const { createExtractor } = require("./extract.js");
const { createFetchTool, parseHostList } = require("./fetch.js");
const { createFindingTools, renderReview } = require("./findings.js");
const { fetchPullRequest, fillDiffAnchors, fetchCommentableLines, postReview } = require("./github.js");
const { DEFAULT_SKILL, loadSkills, selectSkills, buildEnvironmentPreamble, buildSystemPrompt, buildUserPrompt } = require("./skills.js");
const { createTools } = require("./tools.js");

const UNFINISHED_REPORT = "_The review didn't finish within the turn limit. The findings below were staged before that; the list may be incomplete._";

const SYSTEM_PROMPT = `The current year is ${new Date().getFullYear()}. Newer versions of software, GitHub Actions, and model names than you're aware of from training may still be valid and correct. Do not flag version strings, action references (e.g. actions/checkout@vN), or model names as errors solely because they are unfamiliar to you.`;

function parseMaxTurns(value) {
  const maxTurns = parseInt(value);
  return maxTurns > 0 ? maxTurns : DEFAULT_MAX_TURNS;
}

module.exports = async ({ github, context, core }) => {
  const apiKey = process.env.API_KEY;
  const endpoint = process.env.API_ENDPOINT;
  const model = process.env.MODEL;
  const fallbackModel = process.env.FALLBACK_MODEL;
  // Small model for support tasks: checking the staged findings and extracting the relevant lines from large
  // `fetch_url` responses. Empty disables both.
  const supportModel = process.env.SUPPORT_MODEL;
  const title = process.env.TITLE || "AI Code Review";
  const prNumber = parseInt(process.env.PR_NUMBER);
  const repoPath = process.env.REPO_PATH;
  const skillsPath = process.env.SKILLS_PATH;
  const skillName = process.env.SKILL || DEFAULT_SKILL;
  const maxTurns = parseMaxTurns(process.env.MAX_TURNS);
  // An empty allowlist disables `fetch_url`, so the agent has no network access.
  const allowedHosts = parseHostList(process.env.FETCH_ALLOWLIST);
  const extractor = allowedHosts.length > 0 && supportModel ? createExtractor(core, { endpoint, apiKey, model: supportModel }) : undefined;
  const fetch = allowedHosts.length > 0 ? { allowedHosts, blockedHosts: parseHostList(process.env.FETCH_BLOCKLIST), extract: extractor?.extract } : undefined;
  const { owner, repo } = context.repo;

  if (!prNumber) {
    core.setFailed("ai-review: no pull request number found.");
    return;
  }
  if (!repoPath || !skillsPath) {
    core.setFailed("ai-review: REPO_PATH and SKILLS_PATH must point to the PR checkout and the skills checkout.");
    return;
  }

  // The token is only used here and for posting; the agent's tools never see it.
  core.info(`ai-review: fetching PR ${owner}/${repo}#${prNumber}`);
  const pr = await fetchPullRequest(github, { owner, repo, prNumber });
  core.info(`ai-review: PR "${pr.title}" (${pr.base.ref}...${pr.head.ref}, head ${pr.head.sha})`);
  // Fetched before the review, so that `add_finding` can tell the model where a finding will be posted.
  let commentable;
  try {
    commentable = await fetchCommentableLines(github, { owner, repo, prNumber });
  } catch (err) {
    core.warning(`ai-review: failed to list the PR's changed lines (${err.message}); posting all findings in the review body.`);
  }

  const skills = loadSkills(skillsPath, {
    onError: (file, err) => core.warning(`ai-review: skipping skill ${file}: ${err.message}`),
  });
  const { mainSkill, otherSkills } = selectSkills(skills, skillName);
  core.info(`ai-review: loaded skill "${mainSkill.name}" from ${skillsPath}; indexed: ${otherSkills.map((skill) => skill.name).join(", ") || "none"}`);
  const preamble = buildEnvironmentPreamble({
    pr,
    repository: `${owner}/${repo}`,
    serverUrl: context.serverUrl,
    repoPath,
    fetch,
  });

  const systemPrompt = `${SYSTEM_PROMPT}\n\n${buildSystemPrompt({ preamble, mainSkill, otherSkills })}`;
  core.debug(`ai-review: system prompt:\n${systemPrompt}`);
  core.info(`ai-review: starting review of ${repoPath} with "${model}" (fallback "${fallbackModel || "none"}", max ${maxTurns} turns, system prompt ${Buffer.byteLength(systemPrompt)} bytes)`);
  const findingTools = createFindingTools({ repoPath, commentable });
  const tools = [...createTools({ repoPath, skillsPath }), ...findingTools.tools];
  if (fetch) {
    core.info(`ai-review: fetch_url enabled for ${allowedHosts.join(", ")}; blocked: ${fetch.blockedHosts.join(", ") || "none"}; extraction: ${extractor ? `"${supportModel}"` : "off"}`);
    tools.push(createFetchTool({ ...fetch, onRequest: (message) => core.info(`ai-review: fetch_url: ${message}`) }));
  }
  const result = await runAgent(core, {
    endpoint,
    apiKey,
    model,
    fallbackModel,
    systemPrompt,
    userPrompt: buildUserPrompt(pr),
    tools,
    maxTurns,
  });
  core.info(`ai-review: review finished by "${result.model}" after ${result.turns} turns (${result.usage.total_tokens} tokens).`);
  const usageRows = [[result.model, String(result.turns), result.usage]];
  if (extractor && extractor.usage.total_tokens > 0) usageRows.push([`${supportModel} (fetch extraction)`, "-", extractor.usage]);

  let findings = findingTools.findings();
  if (result.report === undefined && findings.length === 0) {
    throw new Error(`no review was submitted within ${maxTurns} turns and no findings were staged`);
  }
  if (supportModel && findings.length > 0) {
    core.info(`ai-review: checking ${findings.length} finding(s) with "${supportModel}"`);
    const check = await checkFindings(core, { endpoint, apiKey, model: supportModel, findings });
    findings = check.findings;
    core.info(`ai-review: kept ${findings.length} finding(s), dropped ${check.dropped.length} (${check.usage.total_tokens} tokens).`);
    usageRows.push([`${supportModel} (finding check)`, "-", check.usage]);
  }
  await core.summary
    .addHeading(title, 3)
    .addTable([
      [{ data: "Model", header: true }, { data: "Turns", header: true }, { data: "Prompt tokens", header: true }, { data: "Completion tokens", header: true }, { data: "Total tokens", header: true }],
      ...usageRows.map(([name, turns, usage]) => [name, turns, String(usage.prompt_tokens), String(usage.completion_tokens), String(usage.total_tokens)]),
    ])
    .write();

  const review = renderReview({
    report: result.report ?? UNFINISHED_REPORT,
    findings,
    commentable,
    repoUrl: `${context.serverUrl}/${owner}/${repo}`,
    headSha: pr.head.sha,
  });
  core.info(`ai-review: ${review.comments.length} of ${findings.length} finding(s) are on changed lines and are posted inline`);

  const body = `## ${title}\n\n${fillDiffAnchors(review.body, pr.html_url)}`;
  const comments = review.comments.map((c) => ({ ...c, body: fillDiffAnchors(c.body, pr.html_url) }));
  core.info(`ai-review: posting review (${Buffer.byteLength(body)} bytes, ${comments.length} inline comment(s))`);
  await postReview(github, core, { owner, repo, prNumber, body, comments });
  core.info("ai-review: review posted");
};
