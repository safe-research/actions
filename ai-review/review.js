const { runAgent, DEFAULT_MAX_TURNS } = require("./agent.js");
const { fetchPullRequest, fillDiffAnchors, postReview } = require("./github.js");
const { DEFAULT_SKILL, loadSkills, selectSkills, buildEnvironmentPreamble, buildSystemPrompt, buildUserPrompt } = require("./skills.js");
const { createTools } = require("./tools.js");

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
  const title = process.env.TITLE || "AI Code Review";
  const prNumber = parseInt(process.env.PR_NUMBER);
  const repoPath = process.env.REPO_PATH;
  const skillsPath = process.env.SKILLS_PATH;
  const skillName = process.env.SKILL || DEFAULT_SKILL;
  const maxTurns = parseMaxTurns(process.env.MAX_TURNS);
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
    skillsPath,
  });

  const systemPrompt = `${SYSTEM_PROMPT}\n\n${buildSystemPrompt({ preamble, mainSkill, otherSkills })}`;
  core.debug(`ai-review: system prompt:\n${systemPrompt}`);
  core.info(`ai-review: starting review of ${repoPath} with "${model}" (fallback "${fallbackModel || "none"}", max ${maxTurns} turns, system prompt ${Buffer.byteLength(systemPrompt)} bytes)`);
  const result = await runAgent(core, {
    endpoint,
    apiKey,
    model,
    fallbackModel,
    systemPrompt,
    userPrompt: buildUserPrompt(pr),
    tools: createTools({ repoPath, skillsPath }),
    maxTurns,
  });
  core.info(`ai-review: review submitted by "${result.model}" after ${result.turns} turns (${result.usage.total_tokens} tokens).`);
  await core.summary
    .addHeading(title, 3)
    .addTable([
      [{ data: "Model", header: true }, { data: "Turns", header: true }, { data: "Prompt tokens", header: true }, { data: "Completion tokens", header: true }, { data: "Total tokens", header: true }],
      [result.model, String(result.turns), String(result.usage.prompt_tokens), String(result.usage.completion_tokens), String(result.usage.total_tokens)],
    ])
    .write();

  const body = `## ${title}\n\n${fillDiffAnchors(result.report, pr.html_url)}`;
  core.info(`ai-review: posting review (${Buffer.byteLength(body)} bytes)`);
  await postReview(github, core, { owner, repo, prNumber, body });
  core.info("ai-review: review posted");
};
