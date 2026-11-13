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
3. The model explores the checkout with read-only tools until it calls `submit_review` with its Markdown report: `read_file`, `list_files`, `grep` (`git grep`), and `git` (only `diff`, `log`, `show`, `merge-base`, `rev-parse`, `cat-file -e`, `ls-files`, `status`). Paths are confined to the two checkouts; there is no shell and no network access, and the tools never see `github-token`. After `max-turns` turns the model is asked to submit what it has.
4. The report is posted as a `COMMENT` review under a `## <title>` heading. The `<file hash>` placeholders in its "Files changed" links are filled in with the SHA-256 of the linked path.

If a model request fails, it is retried with `fallback-model`, and the rest of the review continues on that model. The turn count and token usage are written to the job summary.

The log shows the progress: each step, and for every turn the model, the token usage and the tool calls with the size of their output. With [debug logging](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/troubleshooting-workflows/enabling-debug-logging) enabled, the details are logged as well: the system prompt, the full tool output, and the raw model responses.

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-key` | yes | | API key for the OpenAI-compatible endpoint |
| `endpoint` | no | `https://generativelanguage.googleapis.com/v1beta/openai/` | Base URL of the API; `/chat/completions` is appended. Must support tool calling |
| `model` | no | `gemini-3.6-flash` | Model used for the review |
| `fallback-model` | no | `gemini-3.5-flash-lite` | Model to continue with on error; set empty to disable |
| `github-token` | no | `${{ github.token }}` | Token used to check out and read the PR and post the review |
| `pr-number` | no | `${{ github.event.pull_request.number }}` | PR to review |
| `title` | no | `AI Code Review` | Heading of the posted review (useful with multiple reviewers) |
| `skills-ref` | no | pinned commit | Commit SHA of `safe-research/agents` to load the skills from |
| `skill` | no | `review-pr` | Skill whose instructions define the review |
| `max-turns` | no | `40` | Maximum number of agent turns (model requests) before the report is requested |

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

For Gemini, get an API key from [Google AI Studio](https://aistudio.google.com/app/apikey). Any other OpenAI-compatible server works by setting `endpoint` and the model inputs (e.g. a self-hosted server reached via [`tailscale/github-action`](https://github.com/tailscale/github-action)).

#### Local testing

`local-test.js` runs the review against a real PR but prints the review and job summary instead of posting them. It needs a local checkout of the PR head (with the base commit available) and of `safe-research/agents`:

```sh
git -C ../repo fetch origin pull/123/head && git -C ../repo checkout FETCH_HEAD
REPO=owner/repo PR_NUMBER=123 REPO_PATH=../repo SKILLS_PATH=../agents \
API_KEY=... API_ENDPOINT=https://generativelanguage.googleapis.com/v1beta/openai/ \
MODEL=gemini-3.6-flash FALLBACK_MODEL=gemini-3.5-flash-lite \
node ai-review/local-test.js
```

`SKILL` and `MAX_TURNS` are read from the environment as well. `DEBUG=1` also prints the details: the system prompt, the full output of every tool call, and the raw model responses. Set `GITHUB_TOKEN` to avoid GitHub's unauthenticated rate limit.

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
