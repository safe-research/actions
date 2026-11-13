const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const {
  parseFrontmatter,
  parseSkill,
  loadSkills,
  selectSkills,
  buildEnvironmentPreamble,
  buildSkillIndex,
  buildSystemPrompt,
  buildUserPrompt,
} = require("../skills.js");

function write(root, file, content) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

const PR = {
  number: 42,
  title: "Add feature",
  body: "Implements the feature.\n\n```js\ncode();\n```",
  html_url: "https://github.com/acme/widgets/pull/42",
  state: "open",
  merged_at: null,
  base: { ref: "main", sha: "a".repeat(40) },
  head: { ref: "feat/x", sha: "b".repeat(40) },
};

describe("parseFrontmatter", () => {
  it("parses plain, quoted and block scalar values", () => {
    const { attributes, body } = parseFrontmatter([
      "---",
      "name: review-pr",
      'quoted: "a: \\"b\\""',
      "single: 'it''s'",
      "folded: >",
      "  first line",
      "  second line",
      "literal: |",
      "  one",
      "  two",
      "after: value",
      "---",
      "",
      "# Body",
      "",
    ].join("\n"));
    assert.deepEqual(attributes, {
      name: "review-pr",
      quoted: 'a: "b"',
      single: "it's",
      folded: "first line second line",
      literal: "one\ntwo",
      after: "value",
    });
    assert.equal(body, "# Body");
  });

  it("keeps colons inside unquoted values", () => {
    const { attributes } = parseFrontmatter("---\ndescription: Plan epics: features or refactors.\n---\nBody\n");
    assert.equal(attributes.description, "Plan epics: features or refactors.");
  });

  it("handles CRLF line endings", () => {
    const { attributes, body } = parseFrontmatter("---\r\nname: x\r\n---\r\nBody\r\n");
    assert.equal(attributes.name, "x");
    assert.equal(body, "Body");
  });

  it("rejects files without frontmatter", () => {
    assert.throws(() => parseFrontmatter("# Just a body\n"), /missing frontmatter/);
    assert.throws(() => parseFrontmatter("---\nname: x\n# never closed\n"), /missing frontmatter/);
  });
});

describe("parseSkill", () => {
  it("requires name and description", () => {
    assert.throws(() => parseSkill("---\nname: x\n---\nBody\n"), /missing "description"/);
    assert.throws(() => parseSkill("---\ndescription: d\n---\nBody\n"), /missing "name"/);
    assert.deepEqual(parseSkill("---\nname: x\ndescription: d\n---\nBody\n"), { name: "x", description: "d", body: "Body" });
  });
});

describe("loadSkills", () => {
  let skillsPath;

  before(() => {
    skillsPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-review-skills-test-"));
    write(skillsPath, "skills/review-pr/SKILL.md", "---\nname: review-pr\ndescription: Review a PR.\n---\n\n# Review PR\n\nDo the review.\n");
    write(skillsPath, "skills/plan-epic/SKILL.md", "---\nname: plan-epic\ndescription: Plan epics: larger changes.\n---\n\n# Plan Epic\n");
    write(skillsPath, "skills/plan-epic/template.md", "# Template\n");
    write(skillsPath, "skills/broken/SKILL.md", "no frontmatter\n");
    write(skillsPath, "skills/no-skill-file/README.md", "# Not a skill\n");
    write(skillsPath, "skills/README.md", "# Skills\n");
  });

  after(() => fs.rmSync(skillsPath, { recursive: true, force: true }));

  it("loads all valid skills sorted by name and reports broken ones", () => {
    const errors = [];
    const skills = loadSkills(skillsPath, { onError: (file, err) => errors.push({ file, message: err.message }) });
    assert.deepEqual(skills.map((skill) => skill.name), ["plan-epic", "review-pr"]);
    const reviewPr = skills.find((skill) => skill.name === "review-pr");
    assert.equal(reviewPr.description, "Review a PR.");
    assert.equal(reviewPr.body, "# Review PR\n\nDo the review.");
    assert.equal(reviewPr.path, path.join(skillsPath, "skills/review-pr/SKILL.md"));
    assert.deepEqual(errors, [{ file: path.join(skillsPath, "skills/broken/SKILL.md"), message: "missing frontmatter" }]);
  });

  it("fails if the skills directory doesn't exist", () => {
    assert.throws(() => loadSkills(path.join(skillsPath, "missing")), /cannot read skills directory/);
  });

  it("selects the main skill and keeps the others for the index", () => {
    const { mainSkill, otherSkills } = selectSkills(loadSkills(skillsPath), "review-pr");
    assert.equal(mainSkill.name, "review-pr");
    assert.deepEqual(otherSkills.map((skill) => skill.name), ["plan-epic"]);
  });

  it("fails with the available skills if the main skill is missing", () => {
    assert.throws(() => selectSkills(loadSkills(skillsPath), "missing"), /skill "missing" not found; available skills: plan-epic, review-pr/);
    assert.throws(() => selectSkills([], "review-pr"), /available skills: none/);
  });
});

describe("prompt assembly", () => {
  const mainSkill = { name: "review-pr", description: "Review a PR.", body: "# Review PR\n\nDo the review.", path: "/skills/skills/review-pr/SKILL.md" };
  const planEpic = { name: "plan-epic", description: "Plan epics.", body: "# Plan Epic", path: "/skills/skills/plan-epic/SKILL.md" };
  const preambleArgs = { pr: PR, repository: "acme/widgets", repoPath: "/work/pr", skillsPath: "/skills" };

  it("includes PR metadata, paths and environment constraints in the preamble", () => {
    const preamble = buildEnvironmentPreamble(preambleArgs);
    for (const expected of [
      "`acme/widgets` (https://github.com/acme/widgets)",
      "#42 (https://github.com/acme/widgets/pull/42)",
      "State: open",
      `\`main\` at \`${"a".repeat(40)}\``,
      `\`feat/x\` at \`${"b".repeat(40)}\``,
      "checked out at `/work/pr`",
      "skills directory `/skills`",
      "You have no shell",
      "call `submit_review` exactly once",
      "no network access",
      "no subagents",
    ]) {
      assert.ok(preamble.includes(expected), `missing: ${expected}`);
    }
  });

  it("fences the PR description so it can't close the fence", () => {
    const preamble = buildEnvironmentPreamble(preambleArgs);
    assert.ok(preamble.includes("````text\nAdd feature\n\nImplements the feature.\n\n```js\ncode();\n```\n````"));
  });

  it("handles a missing description and merged PRs", () => {
    const preamble = buildEnvironmentPreamble({ ...preambleArgs, pr: { ...PR, body: null, state: "closed", merged_at: "2026-10-27T00:00:00Z" } });
    assert.ok(preamble.includes("(no description provided)"));
    assert.ok(preamble.includes("State: merged"));
  });

  it("lists the other skills with their paths", () => {
    assert.equal(buildSkillIndex([]), "");
    const index = buildSkillIndex([planEpic]);
    assert.ok(index.includes("- `plan-epic` (`/skills/skills/plan-epic/SKILL.md`): Plan epics."));
    assert.ok(!index.includes("# Plan Epic"), "the index must not include skill bodies");
  });

  it("assembles the system prompt in order", () => {
    const prompt = buildSystemPrompt({ preamble: "# Environment", mainSkill, otherSkills: [planEpic] });
    const environment = prompt.indexOf("# Environment");
    const instructions = prompt.indexOf("# Instructions");
    const body = prompt.indexOf("Do the review.");
    const index = prompt.indexOf("# Other skills");
    assert.ok(environment === 0 && environment < instructions && instructions < body && body < index);
    assert.ok(!buildSystemPrompt({ preamble: "# Environment", mainSkill, otherSkills: [] }).includes("# Other skills"));
  });

  it("asks for the review of the PR", () => {
    assert.equal(buildUserPrompt(PR), "Review PR #42.");
  });
});
