#!/usr/bin/env node
// Local harness for review.js — hits the real GitHub API for PR metadata but
// stubs createReview to print instead of posting, so prompt edits can be
// iterated on without deploying or leaving comments on the PR.
//
// REPO_PATH is a local checkout of the PR head (with the base commit available,
// e.g. `git fetch origin pull/123/head && git checkout FETCH_HEAD`) and
// SKILLS_PATH a local checkout of safe-research/agents.
//
// The variables are read from a `.env` file in the current directory if it
// exists (`KEY=value` per line); variables set in the shell take precedence.
//
// Usage (public repos, no token needed; set GITHUB_TOKEN to avoid GitHub's
// unauthenticated rate limit):
//   REPO=owner/repo PR_NUMBER=123 REPO_PATH=../repo SKILLS_PATH=../agents \
//   API_KEY=sk-xxx API_ENDPOINT=https://generativelanguage.googleapis.com/v1beta/openai/ \
//   MODEL=gemini-3.6-flash \
//   node ai-review/local-test.js

const fs = require("node:fs");
const path = require("node:path");

const review = require("./review.js");

if (fs.existsSync(".env")) process.loadEnvFile(".env");

const token = process.env.GITHUB_TOKEN;
const [owner, repo] = (process.env.REPO || "").split("/");

if (!owner || !repo || !process.env.PR_NUMBER || !process.env.REPO_PATH || !process.env.SKILLS_PATH) {
  console.error("Usage: REPO=owner/repo PR_NUMBER=123 REPO_PATH=<PR checkout> SKILLS_PATH=<agents checkout> API_KEY=... node local-test.js");
  process.exit(1);
}
// The tools resolve paths against these, and the model sees them in the prompt.
process.env.REPO_PATH = path.resolve(process.env.REPO_PATH);
process.env.SKILLS_PATH = path.resolve(process.env.SKILLS_PATH);

async function ghRequest(path, { headers, ...opts } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: "application/vnd.github+json",
      "User-Agent": "ai-review-local-test",
      ...headers,
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${path}: ${await res.text()}`);
  return res;
}

const github = {
  rest: {
    pulls: {
      get: async ({ owner, repo, pull_number }) => {
        const res = await ghRequest(`/repos/${owner}/${repo}/pulls/${pull_number}`);
        return { data: await res.json() };
      },
      createReview: async (params) => {
        console.log("\n===== DRY RUN: would post this review =====");
        console.log(`event: ${params.event}`);
        console.log(`body:\n${params.body}`);
        for (const c of params.comments || []) {
          console.log(`\n-- ${c.path}:${c.line} --\n${c.body}`);
        }
        console.log("=============================================\n");
        return { data: {} };
      },
    },
  },
};

const context = { repo: { owner, repo }, serverUrl: "https://github.com" };

// Mimics the chainable job summary API of @actions/core and prints the summary instead of writing it.
const summaryLines = [];
const summary = {
  addHeading: (text) => (summaryLines.push(text), summary),
  addTable: (rows) => (summaryLines.push(...rows.map((row) => row.map((cell) => cell.data ?? cell).join(" | "))), summary),
  write: async () => {
    console.log(`\n===== job summary =====\n${summaryLines.join("\n")}\n`);
    summaryLines.length = 0;
    return summary;
  },
};

const core = {
  debug: (msg) => process.env.DEBUG && console.debug(msg),
  info: (msg) => console.log(msg),
  warning: (msg) => console.warn(msg),
  setFailed: (msg) => {
    console.error("[failed]", msg);
    process.exitCode = 1;
  },
  summary,
};

review({ github, context, core }).catch((err) => {
  console.error(err);
  process.exit(1);
});
