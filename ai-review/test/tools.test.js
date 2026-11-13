const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const { createTools, validateGitArgs, truncate } = require("../tools.js");

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function git(cwd, ...args) {
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV });
}

function write(root, file, content) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

describe("tools", () => {
  let tmp, repoPath, skillsPath, outside, tools;
  const run = (name, args) => tools.find((tool) => tool.name === name).run(args);

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-review-tools-test-"));
    repoPath = path.join(tmp, "repo");
    skillsPath = path.join(tmp, "skills");
    outside = path.join(tmp, "outside");

    write(outside, "secret.txt", "top secret\n");

    write(repoPath, "README.md", "# Test\nhello world\n");
    write(repoPath, "src/main.js", "function main() {\n  return 42;\n}\n");
    write(repoPath, "src/lib/util.js", "exports.answer = 42;\n");
    write(repoPath, "big.txt", `${"x".repeat(200)}\n`.repeat(100));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(repoPath, "escape.txt"));
    fs.symlinkSync("src/main.js", path.join(repoPath, "inside-link.js"));
    git(repoPath, "init", "-q");
    git(repoPath, "add", ".");
    git(repoPath, "commit", "-q", "-m", "initial");
    write(repoPath, "src/main.js", "function main() {\n  return 43;\n}\n");
    git(repoPath, "commit", "-q", "-am", "change answer");

    write(skillsPath, "skills/review-pr/SKILL.md", "---\nname: review-pr\n---\nReview it.\n");
    git(skillsPath, "init", "-q");
    git(skillsPath, "add", ".");
    git(skillsPath, "commit", "-q", "-m", "skills");

    tools = createTools({ repoPath, skillsPath, maxOutputBytes: 1024 });
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("exposes OpenAI-style function definitions", () => {
    assert.deepEqual(tools.map((tool) => tool.name), ["read_file", "list_files", "grep", "git"]);
    for (const tool of tools) {
      assert.equal(typeof tool.description, "string");
      assert.equal(tool.parameters.type, "object");
      assert.equal(typeof tool.run, "function");
    }
  });

  describe("read_file", () => {
    it("reads a file with line numbers", async () => {
      assert.equal(await run("read_file", { path: "src/main.js" }), "1\tfunction main() {\n2\t  return 43;\n3\t}");
    });

    it("reads a line range", async () => {
      assert.equal(await run("read_file", { path: "src/main.js", start_line: 2, end_line: 2 }), "2\t  return 43;");
    });

    it("reads files in the skills directory via absolute paths", async () => {
      const result = await run("read_file", { path: path.join(skillsPath, "skills/review-pr/SKILL.md") });
      assert.match(result, /4\tReview it\./);
    });

    it("follows symlinks that stay inside the checkout", async () => {
      assert.match(await run("read_file", { path: "inside-link.js" }), /return 43/);
    });

    it("rejects relative path traversal", async () => {
      await assert.rejects(run("read_file", { path: "../outside/secret.txt" }), /outside the allowed directories/);
      await assert.rejects(run("read_file", { path: "src/../../outside/secret.txt" }), /outside the allowed directories/);
    });

    it("rejects absolute paths outside the allowed directories", async () => {
      await assert.rejects(run("read_file", { path: path.join(outside, "secret.txt") }), /outside the allowed directories/);
      await assert.rejects(run("read_file", { path: "/etc/hostname" }), /outside the allowed directories|path not found/);
    });

    it("rejects symlinks pointing outside", async () => {
      await assert.rejects(run("read_file", { path: "escape.txt" }), /outside the allowed directories/);
    });

    it("rejects directories and missing files", async () => {
      await assert.rejects(run("read_file", { path: "src" }), /not a file/);
      await assert.rejects(run("read_file", { path: "missing.txt" }), /path not found/);
    });

    it("truncates large output", async () => {
      const result = await run("read_file", { path: "big.txt" });
      assert.match(result, /\[output truncated: exceeded 1024 bytes\]$/);
      assert.ok(Buffer.byteLength(result) < 1100);
    });
  });

  describe("list_files", () => {
    it("lists tracked files", async () => {
      const files = (await run("list_files", {})).split("\n");
      assert.ok(files.includes("README.md"));
      assert.ok(files.includes("src/lib/util.js"));
    });

    it("filters by directory and glob", async () => {
      assert.equal(await run("list_files", { path: "src", pattern: "**/*.js" }), "src/lib/util.js\nsrc/main.js");
      assert.equal(await run("list_files", { pattern: "*.md" }), "README.md");
    });

    it("lists files in the skills directory", async () => {
      assert.equal(await run("list_files", { path: skillsPath }), "skills/review-pr/SKILL.md");
    });

    it("rejects directories outside the allowed directories", async () => {
      await assert.rejects(run("list_files", { path: ".." }), /outside the allowed directories/);
    });
  });

  describe("grep", () => {
    it("returns matching lines", async () => {
      assert.equal(await run("grep", { pattern: "return 4[0-9]", path: "src" }), "src/main.js:2:  return 43;");
    });

    it("reports no matches", async () => {
      assert.equal(await run("grep", { pattern: "does-not-exist" }), "No matches.");
    });

    it("treats patterns starting with a dash as patterns", async () => {
      assert.equal(await run("grep", { pattern: "--output" }), "No matches.");
    });

    it("rejects paths outside the allowed directories", async () => {
      await assert.rejects(run("grep", { pattern: "secret", path: "../outside" }), /outside the allowed directories/);
    });
  });

  describe("git", () => {
    it("runs allowed subcommands", async () => {
      assert.equal(await run("git", { args: ["log", "--format=%s"] }), "change answer\ninitial");
      assert.match(await run("git", { args: ["diff", "HEAD~1", "HEAD"] }), /-  return 42;\n\+  return 43;/);
      assert.match(await run("git", { args: ["show", "HEAD~1:src/main.js"] }), /return 42/);
      assert.equal(await run("git", { args: ["cat-file", "-e", "HEAD"] }), "(no output)");
    });

    it("reports git errors", async () => {
      await assert.rejects(run("git", { args: ["show", "does-not-exist"] }), /git show failed/);
    });

    it("rejects subcommands outside the allowlist", async () => {
      await assert.rejects(run("git", { args: ["config", "--list"] }), /not allowed/);
      await assert.rejects(run("git", { args: ["-c", "core.pager=sh", "log"] }), /not allowed/);
      await assert.rejects(run("git", { args: ["cat-file", "-p", "HEAD"] }), /cat-file -e/);
      await assert.rejects(run("git", { args: [] }), /non-empty array/);
    });

    it("rejects forbidden options", async () => {
      for (const arg of ["-c", "-C", "-C50%", "-O/etc/passwd", "--output=/tmp/x", "--outp=/tmp/x", "--no-index", "--no-inde", "--ext-diff", "--textconv", "--git-dir=/tmp", "--work-tree=/tmp", "--exec-path=/tmp", "--config-env=a=b", "--orderfile=/etc/passwd"]) {
        assert.throws(() => validateGitArgs(["diff", arg]), /not allowed/, arg);
      }
    });

    it("disables external diff and textconv for diff-like commands", () => {
      assert.deepEqual(validateGitArgs(["diff", "HEAD"]), ["diff", "--no-ext-diff", "--no-textconv", "HEAD"]);
      assert.deepEqual(validateGitArgs(["log", "--output-indicator-new=+"]), ["log", "--no-ext-diff", "--no-textconv", "--output-indicator-new=+"]);
      assert.deepEqual(validateGitArgs(["rev-parse", "HEAD"]), ["rev-parse", "HEAD"]);
    });
  });
});

describe("truncate", () => {
  it("keeps short output unchanged", () => {
    assert.equal(truncate("hello", 10), "hello");
  });

  it("does not split multi-byte characters", () => {
    assert.equal(truncate("ääää", 3), "ä\n[output truncated: exceeded 3 bytes]");
  });
});
