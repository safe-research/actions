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
| [`ai-review`](#ai-review) | Reviews a PR with an OpenAI-compatible chat completions API and posts the result as a PR review |
| [`install-cargo-llvm-cov`](#install-cargo-llvm-cov) | Installs a pinned, checksum-verified `cargo-llvm-cov` binary plus `llvm-tools-preview` |
| [`install-just`](#install-just) | Installs a pinned, checksum-verified `just` binary |
| [`install-lcov`](#install-lcov) | Builds and caches a pinned version of LCOV |
| [`post-comment`](#post-comment) | Creates or updates a PR/issue comment, identified by a marker string |

### `ai-review`

Two-pass AI review: a context model first picks which repository files are needed to understand the diff, then the review model produces a summary and inline comments, which are posted as a `COMMENT` review. If inline comments can't be posted (e.g. a line outside the diff), they are folded into the review body. If a model call fails, it is retried once with `fallback-model`.

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-key` | yes | | API key for the OpenAI-compatible endpoint |
| `endpoint` | no | `https://generativelanguage.googleapis.com/v1beta/openai/` | Base URL of the API; `/chat/completions` is appended |
| `model` | no | `gemini-3.6-flash` | Model used for the review |
| `context-model` | no | `gemini-3.5-flash-lite` | Model used to select additional context files |
| `fallback-model` | no | `gemini-3.5-flash-lite` | Model to retry with on error; set empty to disable |
| `github-token` | no | `${{ github.token }}` | Token used to read the PR and post the review |
| `pr-number` | no | `${{ github.event.pull_request.number }}` | PR to review |
| `title` | no | `AI Code Review` | Heading of the posted review (useful with multiple reviewers) |

Requires `contents: read` and `pull-requests: write` permissions.

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

`local-test.js` runs the review against a real PR but prints the review instead of posting it:

```sh
REPO=owner/repo PR_NUMBER=123 \
API_KEY=... API_ENDPOINT=https://generativelanguage.googleapis.com/v1beta/openai/ \
MODEL=gemini-3.6-flash CONTEXT_MODEL=gemini-3.5-flash-lite \
node ai-review/local-test.js
```

Set `GITHUB_TOKEN` to avoid GitHub's unauthenticated rate limit.

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
