# Safe Research Actions

Reusable [composite GitHub Actions](https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-composite-action) shared across Safe Research repositories.

Each action lives in its own top-level directory and is self-contained, so it can be referenced remotely or copied 1:1 into another repository (e.g. under `.github/actions/<name>`).

```yaml
- uses: safe-research/actions/<action>@<ref>
```

Pin `<ref>` to a commit SHA (or a tag) rather than `main` for reproducible builds.

## Actions

| Action | Description |
| --- | --- |
| [`ai-review`](#ai-review) | Reviews a PR with the `review-pr` skill in a read-only agent loop over an OpenAI-compatible chat completions API and posts the report as a PR review |
| [`install-cargo-llvm-cov`](#install-cargo-llvm-cov) | Installs a pinned, checksum-verified `cargo-llvm-cov` binary plus `llvm-tools-preview` |
| [`install-just`](#install-just) | Installs a pinned, checksum-verified `just` binary |
| [`install-lcov`](#install-lcov) | Builds and caches a pinned version of LCOV |
| [`post-comment`](#post-comment) | Creates or updates a PR/issue comment, identified by a marker string |

### `ai-review`

Runs the [`review-pr`](https://github.com/safe-research/agents/tree/main/skills/review-pr) skill from [`safe-research/agents`](https://github.com/safe-research/agents) in a small tool-calling agent loop:

1. The PR head (with full history) is checked out to `.ai-review/pr` and `safe-research/agents` at `skills-ref` to `.ai-review/agents`, both with `persist-credentials: false`.
2. The system prompt is assembled from an environment preamble (PR metadata, how the skill's shell commands map to the tools), the body of `skill`, and an index of the other skills, which the model can read on demand.
3. The model explores the checkout with read-only tools until it calls `finalize_review` with a Markdown summary of the review (without the findings, see 5.): `read_file`, `list_files`, `grep` (`git grep`), and `git` (only `diff`, `log`, `show`, `merge-base`, `rev-parse`, `cat-file -e`, `ls-files`, `status`). Paths are confined to the two checkouts; there is no shell, no network access unless [`fetch-allowlist`](#network-access) is set, and the tools never see `github-token`. After `max-turns` turns the model is asked to finalize the review with what it has.
4. The summary and the findings are posted as a `COMMENT` review under a `## <title>` heading. The `<file hash>` placeholders in its "Files changed" links are filled in with the SHA-256 of the linked path.
5. While reviewing, the model stages each verified finding with `add_finding` (and can take it back with `remove_finding`); each result shows the staged findings and whether they will be posted inline. The findings are numbered by priority: those on lines shown in the PR diff are posted as inline comments of the same review, the others are added to the review body under their priority section with a link to the file. If GitHub rejects the inline comments, they're appended to the review body instead. If the model doesn't finalize the review within the turn limit, the staged findings are still posted.
6. Before posting, each staged finding is checked with `support-model` in a separate, minimal request (no tools, no review context; only the finding's title, location and text). Findings that don't describe a concrete problem or don't propose a fix, such as a "finding" confirming that the change is correct, are dropped and logged with the reason. If a check fails or gives no clear answer, the finding is kept.

If a model request fails, it is retried with `fallback-model`, and the rest of the review continues on that model. The turn count and token usage are written to the job summary.

The log shows the progress: each step, and for every turn the model, the token usage and the tool calls with the size of their output. With [debug logging](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/troubleshooting-workflows/enabling-debug-logging) enabled, the details are logged as well: the system prompt, the full tool output, and the raw model responses.

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-key` | yes | | API key for the OpenAI-compatible endpoint |
| `endpoint` | no | `https://generativelanguage.googleapis.com/v1beta/openai/` | Base URL of the API; `/chat/completions` is appended. Must support tool calling |
| `model` | no | `gemini-3.6-flash` | Model used for the review |
| `fallback-model` | no | `gemini-3.5-flash-lite` | Model to continue with on error; set empty to disable |
| `support-model` | no | `gemini-3.5-flash-lite` | Smaller model for support tasks: it checks each staged finding before posting and selects the relevant lines of large `fetch_url` responses (see [Network access](#network-access)). A small model is enough (very small ones, around 1B, drop valid findings too). Set empty to disable both |
| `github-token` | no | `${{ github.token }}` | Token used to check out and read the PR and post the review |
| `pr-number` | no | `${{ github.event.pull_request.number }}` | PR to review |
| `title` | no | `AI Code Review` | Heading of the posted review (useful with multiple reviewers) |
| `skills-ref` | no | pinned commit | Commit SHA of `safe-research/agents` to load the skills from |
| `skill` | no | `review-pr` | Skill whose instructions define the review |
| `max-turns` | no | `40` | Maximum number of agent turns (model requests) before the model is asked to finalize the review |
| `fetch-allowlist` | no | `""` | Hosts the agent may send HTTPS GET requests to (comma- or newline-separated exact hostnames), or `*` for any public host; empty disables network access. See [Network access](#network-access) |
| `fetch-blocklist` | no | `""` | Domains the agent may never fetch from, including their subdomains (e.g. your tailnet's `ts.net` domain) |
| `fetch-sources` | no | `""` | Additional sources the agent is told about, one per line with at least one `https://` URL. See [Network access](#network-access) |

Requires `contents: read` and `pull-requests: write` permissions. Because the action checks out the PR's code (it only reads it, nothing is executed), don't run it on `pull_request_target`; fork PRs without access to the API key secret can't be reviewed.

```yaml
on:
  pull_request:
    types: [opened, reopened]
  workflow_dispatch:
    inputs:
      pr-number:
        required: true

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: safe-research/actions/ai-review@<ref>
        with:
          api-key: ${{ secrets.GEMINI_API_KEY }}
          pr-number: ${{ inputs.pr-number || github.event.pull_request.number }}
          title: "Gemini Code Review"
```

#### Network access

By default the agent has no network access. With `fetch-allowlist` set, it gets a `fetch_url` tool, which it uses where the skill says `curl`. This lets it check what the PR relies on as it is today instead of relying on its training data, for example:

- load documentation, e.g. `https://docs.rs/<crate>/<version>/...`;
- look up package details such as the latest version on npm (`https://registry.npmjs.org/<package>/latest`), crates.io or PyPI;
- search GitHub (`api.github.com/search/repositories`, `/search/issues`) and Stack Overflow (`api.stackexchange.com`) for related code and issues, and read files of other repositories via `raw.githubusercontent.com`. GitHub's code search needs authentication, so it isn't available.

`fetch-allowlist: "*"` allows any public host; a list of hostnames allows only exactly those hosts (no wildcards or subdomains). Either way:

- Only unauthenticated `GET` requests to `https://` URLs on the default port are sent: no `github-token`, no cookies, no other credentials.
- URLs must use a hostname with at least one dot; IP addresses are rejected. Every hostname must resolve only to public addresses. This is checked on the address the connection is actually made to, so names resolving to loopback, private networks, link-local addresses (e.g. cloud metadata) or the Tailscale range (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) are refused. `localhost`, `.local`, `.internal` and `.home.arpa` names are always blocked, plus the domains in `fetch-blocklist`, e.g. `fetch-blocklist: tail1234.ts.net` for your tailnet's MagicDNS names.
- Redirects are followed (up to 5) and every hop is checked the same way.
- The response is always decoded as text, whatever its content type. HTML pages are reduced to their text, without scripts, styles, the site navigation (`<nav>`) and the footer (the model can ask for the raw source). Requests time out after 15 s; at most 1 MB is downloaded and 50 KB is returned to the model.
- With `support-model` set, the model can pass a `question` with the URL. For responses over 8 KB, `support-model` then picks the line ranges that answer it (it only answers with line numbers), and the action returns those lines verbatim with their line numbers, up to 8 KB, instead of the start of the page. JSON is pretty-printed first, so minified documents have lines to pick. If the support model fails or gives no usable answer, the response is returned from the start as without a question. Responses are cached for the run, so another question about the same page doesn't download it again.
- Every request is logged with its status in the job log.

The agent only knows the sources it's told about. With `fetch-sources`, you can point it at documentation and APIs it wouldn't find on its own, e.g. your project's docs or a docs search service. Each line describes one source in free text, what it covers and how to use it, with at least one `https://` URL (placeholders like `<library>` are fine). The lines are listed in the system prompt, so the agent checks these sources first. A line is skipped with a warning if it has no `https://` URL or if one of its hosts isn't allowed by `fetch-allowlist` or is blocked. For docs that only matter to one repository, a link in its `AGENTS.md` works as well, and the skill reads that file anyway.

The risk: anything on an allowed host becomes reachable, and the URL itself is a channel out of the job. Prompt injection in the PR could make the agent put repository content into a URL sent to a host the attacker controls, which is why `*` is only acceptable when that content is public anyway. The action runs read-only and the agent's tools have no access to secrets. Use it for public repositories; for private ones, use an explicit list of hosts that don't expose request URLs to third parties, or leave network access disabled.

```yaml
      - uses: safe-research/actions/ai-review@<ref>
        with:
          api-key: ${{ secrets.GEMINI_API_KEY }}
          fetch-allowlist: "*"
          fetch-blocklist: tail1234.ts.net
          fetch-sources: |
            Safe protocol docs: https://docs.safefoundation.org/llms.txt (page index), https://docs.safefoundation.org/llms-full.txt (all pages; ask a question)
            Library docs (Context7): search with https://context7.com/api/v1/search?query=<library>, then fetch https://context7.com/api/v1/<library id>?type=txt&topic=<topic>&tokens=5000
```

For Gemini, get an API key from [Google AI Studio](https://aistudio.google.com/app/apikey). Any other OpenAI-compatible server works by setting `endpoint` and the model inputs (e.g. a self-hosted server reached via [`tailscale/github-action`](https://github.com/tailscale/github-action)).

#### Local testing

`local-test.js` runs the review against a real PR but prints the review (including inline comments) and job summary instead of posting them. It needs a local checkout of the PR head (with the base commit available) and of `safe-research/agents`:

```sh
git -C ../repo fetch origin pull/123/head && git -C ../repo checkout FETCH_HEAD
REPO=owner/repo PR_NUMBER=123 REPO_PATH=../repo SKILLS_PATH=../agents \
API_KEY=... API_ENDPOINT=https://generativelanguage.googleapis.com/v1beta/openai/ \
MODEL=gemini-3.6-flash FALLBACK_MODEL=gemini-3.5-flash-lite \
node ai-review/local-test.js
```

`SKILL`, `MAX_TURNS`, `SUPPORT_MODEL`, `FETCH_ALLOWLIST`, `FETCH_BLOCKLIST` and `FETCH_SOURCES` are read from the environment as well; without `SUPPORT_MODEL`, the findings aren't checked and `fetch_url` responses aren't extracted. `DEBUG=1` also prints the details: the system prompt, the full output of every tool call, and the raw model responses. Set `GITHUB_TOKEN` to avoid GitHub's unauthenticated rate limit.

Instead of passing the variables on the command line, you can put them in a `.env` file (one `KEY=value` per line) in the directory you run the script from; it's ignored by git. Variables set in the shell take precedence over the file:

```sh
cat > .env <<'EOF'
REPO=owner/repo
REPO_PATH=../repo
SKILLS_PATH=../agents
API_KEY=...
API_ENDPOINT=https://generativelanguage.googleapis.com/v1beta/openai/
MODEL=gemini-3.6-flash
EOF
PR_NUMBER=123 node ai-review/local-test.js
```

Unit tests use the built-in Node.js test runner (no dependencies required):

```sh
node --test 'ai-review/test/*.test.js'
```

### `install-cargo-llvm-cov`

Installs `cargo-llvm-cov` v0.8.7 (x86_64 Linux, musl build) into `~/.cargo/bin` after verifying its SHA-256 checksum, and adds the `llvm-tools-preview` component to the active Rust toolchain. No inputs; requires `rustup`.

```yaml
- uses: safe-research/actions/install-cargo-llvm-cov@<ref>
```

### `install-just`

Installs [`just`](https://github.com/casey/just) into `/usr/local/bin` from a GitHub release after verifying its SHA-256 checksum, avoiding flaky `apt-get` installs.

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `version` | no | `1.58.0` | `just` version to install |
| `arch-suffix` | no | `x86_64-unknown-linux-musl` | Release asset target suffix |
| `sha256` | no | checksum of the default version | Expected SHA-256 of the release archive |

When changing `version` or `arch-suffix`, `sha256` must be updated too.

```yaml
- uses: safe-research/actions/install-just@<ref>
```

### `install-lcov`

Builds LCOV 1.16 from source (the `apt-get` version is faulty), installs it into `~/.lcov`, caches it with `actions/cache`, and adds `~/.lcov/bin` to `PATH`. No inputs.

```yaml
- uses: safe-research/actions/install-lcov@<ref>
```

### `post-comment`

Posts a comment on a PR or issue. If `marker` is set and an existing comment contains it, that comment is updated instead — handy for sticky reports such as coverage summaries (e.g. use an HTML comment like `<!-- coverage-report -->` as the marker and include it in the content).

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `github-token` | yes | | Token used to post the comment |
| `issue-number` | yes | | PR/issue number to comment on |
| `content` | no | `""` | Markdown body of the comment |
| `content-file` | no | `""` | Path to a file with the body (takes precedence over `content`) |
| `marker` | no | `""` | Unique string used to find and update an existing comment |

One of `content` or `content-file` must be non-empty. Requires `pull-requests: write` (or `issues: write`).

```yaml
- uses: safe-research/actions/post-comment@<ref>
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    issue-number: ${{ github.event.pull_request.number }}
    content-file: coverage-report.md
    marker: "<!-- coverage-report -->"
```
