# Plan: Skill-based AI Review

Component: `ai-review`

---

## Overview

The `ai-review` action currently runs a fixed two-pass prompt: a context model picks up to 15 files, then the review model answers a single structured-output request. The model can't look anything up on its own (callers, tests, `AGENTS.md`, epics, commit messages), and the review instructions live in `review.js` instead of in our shared skill collection.

This epic changes the action to run the [`review-pr`](https://github.com/safe-research/agents/blob/feat/pr_review/skills/review-pr/SKILL.md) skill from [`safe-research/agents`](https://github.com/safe-research/agents) in a small agent loop. The model explores a checkout of the PR itself through read-only tools and returns the skill's Markdown report, which is then posted as a PR review. Review behaviour is then defined in one place, and Claude Code and CI use the same skill.

Steps (one PR each unless noted):

0. **Prerequisite (agents repo):** merge `feat/pr_review` so the skill can be pinned to a commit on `main`.
1. **Refactor:** split `review.js` into an LLM client module and a GitHub I/O module, with no change in behaviour.
2. **Read-only tools:** a sandboxed toolset (`read_file`, `list_files`, `grep`, `git`) with unit tests. *Can run in parallel with 3.*
3. **Agent loop:** a tool-calling loop on top of the LLM client (turn and output limits, fallback model). *Can run in parallel with 2.*
4. **Skill loading:** load `SKILL.md` files from a directory and build the system prompt from the main skill plus an index of the other skills.
5. **Switch over:** check out the PR and the agents repo in `action.yaml`, wire 2–4 together, remove the two-pass flow, and update the README and `local-test.js`.
6. **Inline comments (optional):** have `submit_review` return structured findings and post them as inline comments.
7. **Allowlisted HTTP access (optional):** a `fetch_url` tool limited to a configured list of hosts, so the skill's `curl` steps work for trusted domains.
8. **Cleanup:** remove this plan.

---

## Architecture Decision

### Skills are fetched from `safe-research/agents` at a pinned ref

A new `skills-ref` input (a commit SHA by default) controls which skills are used. `action.yaml` checks out `safe-research/agents` at that ref with `actions/checkout` (pinned by SHA, `persist-credentials: false`) into a directory outside the PR checkout. The skills repo stays the single source of truth, and a consumer can still copy the action 1:1 because the ref is an input. Bumping the default `skills-ref` is a reviewable one-line PR in this repo.

The skills used:

| Skill | Role |
| --- | --- |
| `review-pr` | **Main skill.** Its body is the review instructions. |
| `plan-epic` (incl. `template.md`) | **Reference.** `review-pr` relies on it to find and read epics and their "Implementation Phases". It's listed in the skill index so the model can read it when needed. |
| `handle-pr-comments`, `propose-pr`, … | Not used. `review-pr` only mentions `handle-pr-comments` to say when *not* to use it. |

Project rules such as `snippets/coding-guidelines.md` and `snippets/testing-guidelines.md` reach the model through the reviewed repository's `AGENTS.md`/`CLAUDE.md`, which the skill already tells it to read. They don't need to be loaded separately.

### Our own minimal agent loop on the OpenAI-compatible API

`review-pr` needs an agent: it has to read files, grep for callers, run `git diff`/`git log`, and decide on its own what context to collect. We implement a small tool-calling loop over the existing chat completions endpoint (`tools` / `tool_calls`) instead of adopting an agent CLI:

- **Provider-agnostic:** Gemini (default), self-hosted OpenAI-compatible servers (e.g. reached via Tailscale), and fallback models keep working.
- **No arbitrary shell:** the tools are JS functions. `git` runs via `execFile` with an allowlist of read-only subcommands. Paths are confined to the PR checkout. Nothing has network access by default; the optional Phase 7 adds HTTP GET requests limited to an allowlist of hosts. This limits what prompt injection in a PR can do.
- **No new runtime dependencies:** it still runs inside `actions/github-script`, and `local-test.js` keeps working.

The skill's instructions are written for a shell (`curl`, `git`, `sha256sum`, `GITHUB_EVENT_PATH`). An **environment preamble** in the action closes that gap, so the skill doesn't need CI-specific changes:

- It gives the PR metadata (number, title, body, URL, base/head SHA, repository) directly. This replaces Step 1's API and event-file lookups, which also don't work for `workflow_dispatch` runs.
- It maps the skill's shell commands to the tools (whose definitions are sent via the request's `tools` field) and says that network access and subagents are unavailable. The skill's parallel verification is already optional ("when subagents are available").
- It asks for the final report via the `submit_review` tool.

### Secrets stay out of the agent

The agent's tools never see `github-token`. The token is only used before the loop (fetching PR metadata) and after it (posting the review). The PR checkout uses `persist-credentials: false`. The LLM API key is only used by the LLM client.

### Output

The skill's Markdown report (Step 5 format, with "Files changed" links) is posted as a `COMMENT` review body under the existing `## <title>` heading. The model can't compute the SHA-256 anchors without a shell, so the preamble tells it to write a `<file hash>` placeholder, and the action fills in the SHA-256 of the path from the link text when posting. Inline comments are deferred to the optional Phase 6.

### Alternatives Considered

- **`anthropics/claude-code-action` / `claude -p` with the skill installed into `.claude/skills`:** skills work natively, subagents are included, and there is very little code to maintain. But it ties the action to Anthropic models (no Gemini default, no self-hosted endpoint), and it needs careful `allowedTools` restrictions because the harness has a general-purpose shell. Still a good option if we decide to standardise on Claude. The skill would then work unchanged, and the work in this repo would mostly be `action.yaml`.
- **Other agent CLIs with skill support (Codex CLI, OpenCode, Gemini CLI):** these would be provider-agnostic with less code of our own, but they add a heavy runtime dependency, and each has its own sandboxing model and config format to pin and audit. A small, auditable loop is easier to reason about for a security-focused review action.
- **Vendoring the skill files into `ai-review/`:** fully self-contained, but the copy would drift from the agents repo. Pinning a ref gives the same reproducibility without duplicating the files.
- **Keeping the two-pass flow and pasting the skill text into the prompt:** cheap, but the skill's core steps (reading callers/tests/docs, verifying each finding against the code) can't be done without tools.

---

## Tech Specs

### Files

```
ai-review/
  action.yaml      # + checkout steps, new inputs
  review.js        # orchestration: PR metadata → agent → post
  llm.js           # chat completions client, fallback (Phase 1, tools support Phase 3)
  github.js        # PR metadata + posting (Phase 1)
  tools.js         # read-only tools (Phase 2)
  agent.js         # tool-calling loop (Phase 3)
  skills.js        # SKILL.md loading + prompt assembly (Phase 4)
  local-test.js    # + local checkout / skills dir support
  test/*.test.js   # node:test, run with `node --test 'ai-review/test/*.test.js'`
```

### Inputs (`action.yaml`)

| Input | Change | Notes |
| --- | --- | --- |
| `skills-ref` | **new** | Commit SHA of `safe-research/agents`; defaults to a pinned SHA |
| `skill` | **new** | Main skill name, default `review-pr` |
| `max-turns` | **new** | Agent loop limit, default `40` |
| `fetch-allowlist` | **new** (Phase 7, optional) | Hosts the agent may fetch from (comma- or newline-separated); empty (default) disables network access |
| `context-model` | **removed** | The agent collects its own context |
| `api-key`, `endpoint`, `model`, `fallback-model`, `github-token`, `pr-number`, `title` | unchanged | |

Consumer workflows don't change, apart from dropping `context-model` if they set it. Consumers pin the action by SHA, so removing the input doesn't break existing pins.

### Composite steps

1. `actions/checkout` the PR head into `${{ github.workspace }}/.ai-review/pr`: `ref: refs/pull/<n>/head`, `fetch-depth: 0` so the merge base is available, `persist-credentials: false`.
2. `actions/checkout` `safe-research/agents` at `skills-ref` into `${{ github.workspace }}/.ai-review/agents`, with `persist-credentials: false`.
3. `actions/github-script` runs `review.js` with `REPO_PATH` and `SKILLS_PATH` env vars.

### Tools

| Tool | Behaviour |
| --- | --- |
| `read_file(path, start_line?, end_line?)` | Reads a file in the PR checkout or the skills dir, with line numbers. Output is capped at 50 KB. |
| `list_files(path?, pattern?)` | Lists tracked files (`git ls-files`), optionally filtered by glob. |
| `grep(pattern, path?)` | Runs `git grep -n` in the PR checkout. Output is capped. |
| `git(args[])` | Allowlist: `diff`, `log`, `show`, `merge-base`, `rev-parse`, `cat-file -e`, `ls-files`, `status`. Always passes `--no-ext-diff --no-textconv` where they apply, and rejects `-c`, `--output`, and `-C`. Runs with `GIT_CONFIG_NOSYSTEM=1` and an empty `HOME`, so repo or global config can't trigger helpers. |
| `fetch_url(url)` | *Optional, Phase 7.* HTTPS GET of a URL whose host is in `fetch-allowlist`; only offered when the input is set. |
| `submit_review(report)` | Ends the loop and returns the Markdown report. |

All paths are resolved with `realpath` and must stay inside `REPO_PATH` or `SKILLS_PATH`. Symlinks that point outside are rejected.

### Agent loop

- Messages: `system` = date note (existing `SYSTEM_PROMPT`) + environment preamble + main skill body + skill index. `user` = "Review PR #n".
- Each turn: call chat completions with `tools`, run every `tool_call`, and append the results. Tool errors are returned to the model as text instead of being thrown.
- Stops on `submit_review`. If the model returns plain text without tool calls, that text is used as the report. If `max-turns` is reached, the model is asked once more to submit with what it has.
- The fallback model applies to each request. A conversation that is already running continues on the fallback model after a failure.
- Tool outputs and the turn count are logged with `core.debug`. The total token usage reported by the API goes to the job summary.

### Tests

- `tools.js`: path traversal (`../`, absolute paths, symlinks), the git allowlist and forbidden flags, output truncation.
- `agent.js`: a scripted fake endpoint covering tool round-trips, termination via `submit_review`, the plain-text fallback, the `max-turns` limit, and fallback model switching.
- `skills.js`: frontmatter parsing, a missing main skill, index generation.
- End to end: `local-test.js` against a real PR (manual, described in the PR's Testing section).

---

## Implementation Phases

### Phase 0 — Merge `review-pr` skill (`safe-research/agents`)

Merge `feat/pr_review` into `main` of the agents repo. This is required before Phase 5, which pins the default `skills-ref` to that commit. It doesn't block Phases 1–4.

### Phase 1 — Refactor `review.js` into modules (refactor only)

- Move `callOpenAi`/`callModel`/`callModelWithFallback` into `llm.js`, and move PR fetching and posting (including the fallback that folds comments into the body) into `github.js`.
- No change in behaviour; the prompts stay in `review.js`.
- Files: `review.js`, `llm.js`, `github.js`.

### Phase 2 — Read-only tools *(parallel with Phase 3)*

- `tools.js` with the tools described above, minus `submit_review`, which the loop handles.
- `test/tools.test.js`; add `node --test` to the README's local testing section.
- Not wired into the action yet.

### Phase 3 — Agent loop *(parallel with Phase 2)*

- Add tool-calling support to `llm.js`, returning the raw message instead of parsed JSON.
- `agent.js`: the loop, turn limit, output caps, and fallback model handling. It takes the tool implementations as a parameter, so it can be tested with stub tools.
- `test/agent.test.js` with a fake endpoint.

### Phase 4 — Skill loading and prompt assembly

- `skills.js`: parse `skills/*/SKILL.md` frontmatter (`name`, `description`), return the main skill body and an index of the other skills (`name`, `description`, path readable via `read_file`).
- Environment preamble text (PR metadata, mapping of shell commands to tools, no network/subagents, submit via `submit_review`).
- `test/skills.test.js` with fixture skills.

### Phase 5 — Switch the action to the skill-based review

- `action.yaml`: the two checkout steps, new inputs (`skills-ref`, `skill`, `max-turns`), and removal of `context-model`.
- `review.js`: replace the two-pass flow with PR metadata → `skills.js` prompt → `agent.js` with `tools.js` → post the report. Remove `FILES_SCHEMA`, `REVIEW_SCHEMA`, and the unreachable native Gemini path (`callGemini`).
- Resolve "Files changed" links: the model writes a `<file hash>` placeholder, and `github.js` fills in the SHA-256 of the path from the link text before posting.
- `local-test.js`: take `REPO_PATH` (a local checkout of the PR) and `SKILLS_PATH` (a local agents checkout) instead of fetching file contents via the API.
- README: update the `ai-review` section (how it works, inputs, permissions, local testing).

### Phase 6 — Inline comments *(optional, after Phase 5)*

- Extend `submit_review` with an optional `findings[]` (`path`, `line`, `priority`, `body`) next to `report`. Post findings on changed lines as inline comments and keep the rest in the body. The fold-into-body fallback stays.
- Only worth doing if the posted reports turn out to be hard to act on as a single comment.

### Phase 7 — Allowlisted HTTP access *(optional, after Phase 5)*

The skill uses `curl` for the GitHub API, for interfaces outside the repository ("check them as they were when the PR was written"), and for docs. Give the agent read-only HTTP access, limited to hosts the consumer explicitly allows.

- New input `fetch-allowlist`, passed to `review.js` as the `FETCH_ALLOWLIST` env var: a comma- or newline-separated list of hostnames, e.g. `api.github.com, raw.githubusercontent.com`. A URL is allowed if its hostname (`new URL(url).hostname`) exactly equals one of them; no wildcards or subdomains. Empty (the default) keeps today's behaviour: no `fetch_url` tool and no network access.
- `fetch_url(url)` tool in `tools.js`, implemented with Node's `fetch` rather than by spawning `curl`, so there are no flags to abuse (`-o`, `-d`, `-K`, `file://`, …):
  - `https:` only, `GET` only, no request body, and no credentials: no `github-token`, no cookies, no `Authorization` header from the environment.
  - Redirects aren't followed; a redirect response is returned to the model as an error naming the target, which it can fetch if that host is allowed.
  - Timeout (e.g. 15 s) and the same 50 KB output cap as the other tools.
  - Each request is logged with `core.info` (URL and status), so the job log shows what the agent fetched.
- The environment preamble (`skills.js`) lists `fetch_url` and the allowed hosts when it's enabled, instead of saying there's no network access, and tells the model to use `fetch_url` where the skill says `curl`.
- `local-test.js` reads `FETCH_ALLOWLIST` from the environment as well.
- `test/tools.test.js`: allowlist parsing, exact host matching (`allowed.com.evil.com`, `https://allowed.com@evil.com/`), non-HTTPS URLs, redirects, and the output cap, against a local fake server. `test/skills.test.js`: preamble with and without the allowlist.
- README: document the input and the trade-off below.

Risk: anything on an allowed domain becomes reachable, and the URL itself is a channel out of the job. Prompt injection in the PR could make the agent put repository content into a query string sent to an allowed host. For public repositories that leaks nothing new; for private repositories consumers should only allow hosts that don't log or expose request URLs to third parties. Requests are unauthenticated, so the agent still can't write anything via the GitHub API.

### Phase 8 — Remove this plan

- Delete `epics/2026_10_27_skill_based_ai_review.md`.

---

## Open Questions and Assumptions

- **Harness choice:** this plan assumes we keep provider flexibility (Gemini / self-hosted) and therefore build our own loop. If we're fine using Claude only in CI, `claude-code-action` would replace Phases 2–4 and shrink Phase 5. **Please confirm before Phase 2.**
- **Model capability:** we assume the default models (`gemini-3.6-flash`, fallback `gemini-3.5-flash-lite`) handle multi-turn tool calling over Gemini's OpenAI-compatible endpoint well enough to follow a skill this long. We'll check this with `local-test.js` on a few real PRs in Phase 5, and may change the default model.
- **Cost / runtime:** an agentic review uses more tokens than the two-pass flow. `max-turns` and the output caps bound this. The defaults may need tuning after the first runs.
- **Link anchors:** decided in Phase 5: anchors are rewritten when posting (from the path in the link text) rather than computed by a `sha256` tool, since rewriting doesn't depend on the model calling the tool for every link.
- **Subagent verification:** the skill's optional parallel verification isn't supported. A follow-up could add a `verify_finding` tool that runs a fresh, short sub-loop with only the claim.
- **Skill wording:** we assume `review-pr` needs no CI-specific changes because the environment preamble covers the gaps. If it turns out to need some (e.g. its `curl` instructions confuse the model), that change goes to the agents repo, not here.
- **Fork PRs:** the action keeps relying on the consumer's `pull_request` trigger. Fork PRs without secrets can't run it, as today. `pull_request_target` remains unsupported because the action checks out and reads untrusted PR code.
