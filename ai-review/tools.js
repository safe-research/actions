const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_OUTPUT_BYTES = 50 * 1024;
const GIT_TIMEOUT_MS = 30_000;

const GIT_SUBCOMMANDS = ["diff", "log", "show", "merge-base", "rev-parse", "cat-file", "ls-files", "status"];
const GIT_DIFF_SUBCOMMANDS = ["diff", "log", "show"];
// Long options that write files, read files outside the repository, or run external programs.
// Git accepts unambiguous prefixes of long options, so any prefix of these is rejected as well.
const FORBIDDEN_LONG_OPTIONS = ["output", "no-index", "ext-diff", "textconv", "orderfile", "git-dir", "work-tree", "exec-path", "config-env"];
const FORBIDDEN_SHORT_OPTIONS = ["-c", "-C", "-O"];

function truncate(text, maxBytes = MAX_OUTPUT_BYTES) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  // drop a trailing partial UTF-8 sequence
  const head = buffer.subarray(0, maxBytes).toString("utf8").replace(/�$/, "");
  return `${head}\n[output truncated: exceeded ${maxBytes} bytes]`;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function checkForbiddenGitArg(arg) {
  if (FORBIDDEN_SHORT_OPTIONS.some((option) => arg.startsWith(option))) {
    throw new Error(`git option "${arg}" is not allowed`);
  }
  if (arg.startsWith("--") && arg.length > 2) {
    const name = arg.slice(2).split("=")[0];
    if (FORBIDDEN_LONG_OPTIONS.some((option) => option.startsWith(name))) {
      throw new Error(`git option "${arg}" is not allowed`);
    }
  }
}

function validateGitArgs(args) {
  if (!Array.isArray(args) || args.length === 0 || !args.every((arg) => typeof arg === "string")) {
    throw new Error("args must be a non-empty array of strings");
  }
  const [subcommand, ...rest] = args;
  if (!GIT_SUBCOMMANDS.includes(subcommand)) {
    throw new Error(`git subcommand "${subcommand}" is not allowed; allowed: ${GIT_SUBCOMMANDS.join(", ")}`);
  }
  if (subcommand === "cat-file" && rest[0] !== "-e") {
    throw new Error('only "git cat-file -e <object>" is allowed');
  }
  rest.forEach(checkForbiddenGitArg);
  return GIT_DIFF_SUBCOMMANDS.includes(subcommand) ? [subcommand, "--no-ext-diff", "--no-textconv", ...rest] : args;
}

function createTools({ repoPath, skillsPath, maxOutputBytes = MAX_OUTPUT_BYTES }) {
  const roots = [repoPath, skillsPath].filter(Boolean).map((root) => fs.realpathSync(root));
  const [repoRoot] = roots;
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "ai-review-home-"));
  // Only pass what git needs: no secrets from the action's environment, and no global or system config.
  const gitEnv = {
    PATH: process.env.PATH,
    HOME: emptyHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    LC_ALL: "C",
  };

  // Resolves a path relative to the PR checkout (or absolute inside an allowed root) and returns
  // the root containing it. Symlinks are followed, so links pointing outside are rejected.
  function resolvePath(requested = ".") {
    if (typeof requested !== "string" || requested.includes("\0")) {
      throw new Error("path must be a string");
    }
    const absolute = path.resolve(repoRoot, requested);
    let real;
    try {
      real = fs.realpathSync(absolute);
    } catch {
      throw new Error(`path not found: ${requested}`);
    }
    const root = roots.find((candidate) => isInside(candidate, real));
    if (!root) throw new Error(`path is outside the allowed directories: ${requested}`);
    return { root, real };
  }

  function runGit(cwd, args, okExitCodes = [0]) {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "--no-pager", ...args],
        { cwd, env: gitEnv, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * maxOutputBytes, encoding: "utf8" },
        (err, stdout, stderr) => {
          const code = err ? err.code : 0;
          if (okExitCodes.includes(code)) {
            resolve({ code, stdout });
          } else if (err && err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            resolve({ code: 0, stdout });
          } else {
            reject(new Error(`git ${args[0]} failed: ${(stderr || err.message).trim()}`));
          }
        },
      );
    });
  }

  async function readFile({ path: requested, start_line: startLine, end_line: endLine }) {
    const { real } = resolvePath(requested);
    if (!fs.statSync(real).isFile()) throw new Error(`not a file: ${requested}`);
    const content = fs.readFileSync(real, "utf8");
    if (content.includes("\0")) throw new Error(`binary file: ${requested}`);
    const lines = content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const start = Math.max(1, startLine ?? 1);
    const end = Math.min(lines.length, endLine ?? lines.length);
    if (lines.length === 0) return "(empty file)";
    if (start > end) throw new Error(`invalid line range ${start}-${end}; the file has ${lines.length} lines`);
    const numbered = lines.slice(start - 1, end).map((line, i) => `${start + i}\t${line}`);
    return truncate(numbered.join("\n"), maxOutputBytes);
  }

  async function listFiles({ path: requested, pattern } = {}) {
    const { root, real } = resolvePath(requested);
    const relative = path.relative(root, real) || ".";
    const pathspec = pattern ? `:(glob)${relative === "." ? "" : `${relative}/`}${pattern}` : relative;
    const { stdout } = await runGit(root, ["ls-files", "--", pathspec]);
    return truncate(stdout.trimEnd() || "No files found.", maxOutputBytes);
  }

  async function grep({ pattern, path: requested }) {
    if (typeof pattern !== "string" || pattern === "") throw new Error("pattern must be a non-empty string");
    const { root, real } = resolvePath(requested);
    const relative = path.relative(root, real) || ".";
    // exit code 1 means no matches
    const { code, stdout } = await runGit(root, ["grep", "-n", "-I", "-E", "--no-color", "-e", pattern, "--", relative], [0, 1]);
    return code === 1 ? "No matches." : truncate(stdout.trimEnd(), maxOutputBytes);
  }

  async function git({ args }) {
    const { stdout } = await runGit(repoRoot, validateGitArgs(args));
    return truncate(stdout.trimEnd() || "(no output)", maxOutputBytes);
  }

  return [
    {
      name: "read_file",
      description: "Read a file with line numbers. Relative paths are resolved against the PR checkout; absolute paths are allowed inside the PR checkout and the skills directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          start_line: { type: "integer", description: "First line to return (1-based, inclusive)" },
          end_line: { type: "integer", description: "Last line to return (1-based, inclusive)" },
        },
        required: ["path"],
      },
      run: readFile,
    },
    {
      name: "list_files",
      description: "List files tracked by git, optionally below a directory and filtered by a glob pattern (e.g. \"**/*.ts\"). Patterns are relative to the directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to list; defaults to the PR checkout root" },
          pattern: { type: "string", description: "Glob pattern, e.g. \"src/**/*.js\"" },
        },
      },
      run: listFiles,
    },
    {
      name: "grep",
      description: "Search tracked text files with an extended regular expression (git grep -n -E). Returns matching lines as path:line:content.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Extended regular expression" },
          path: { type: "string", description: "File or directory to search; defaults to the PR checkout root" },
        },
        required: ["pattern"],
      },
      run: grep,
    },
    {
      name: "git",
      description: `Run a read-only git command in the PR checkout. Allowed subcommands: ${GIT_SUBCOMMANDS.join(", ")} (cat-file only with -e). Options that write files or run external programs are rejected.`,
      parameters: {
        type: "object",
        properties: {
          args: { type: "array", items: { type: "string" }, description: "Arguments after \"git\", e.g. [\"log\", \"--oneline\", \"-5\"]" },
        },
        required: ["args"],
      },
      run: git,
    },
  ];
}

module.exports = { createTools, validateGitArgs, truncate, MAX_OUTPUT_BYTES };
