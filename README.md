<div align="center">

<img src="https://raw.githubusercontent.com/wiroai/wiro-action/main/.github/assets/wiro-logo.png" alt="Wiro AI" width="240">

# Wiro AI Action

Run Wiro AI models in GitHub Actions: generate images, video, audio and 3D with any of 1,000+ models, or ask an LLM about your code, and use the results in the next steps of your workflow.

[![CI](https://img.shields.io/github/actions/workflow/status/wiroai/wiro-action/ci.yml?branch=main&style=for-the-badge&label=CI&color=111111)](https://github.com/wiroai/wiro-action/actions/workflows/ci.yml) [![Node.js 24](https://img.shields.io/badge/Node.js-24-111111?style=for-the-badge)](./action.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-111111?style=for-the-badge)](./LICENSE)

[Website](https://wiro.ai) · [Models](https://wiro.ai/models) · [Docs](https://wiro.ai/docs) · [Dashboard](https://wiro.ai/panel)

<img src="https://wiro.ai/images/koala/accent-heavy-koala.png" alt="Wiro AI koala mascot" width="60" />

</div>

`wiroai/wiro-action` calls the [Wiro AI](https://wiro.ai) API from a workflow step. It has two modes:

- **model** runs any model in the catalog, waits for the task to finish and gives you the output URLs, the text and the cost. It can also download the output files into the workspace.
- **llm** sends a prompt, with files if you like, to the Wiro AI LLM gateway and gives you the answer. The gateway speaks the OpenAI Chat Completions protocol.

## Quick start

1. Create a project at [wiro.ai/panel/project/new](https://wiro.ai/panel/project/new) and copy its API key. If the project uses signature authentication, copy the API secret too.
2. In your repository, open **Settings → Secrets and variables → Actions** and add the key as `WIRO_API_KEY` (and the secret as `WIRO_API_SECRET`).
3. Add a step to a workflow:

```yaml
- uses: wiroai/wiro-action@v1
  id: image
  with:
    api-key: ${{ secrets.WIRO_API_KEY }}
    model: pruna/p-image
    prompt: A small paper boat on a calm lake at sunrise, soft light
    params: |
      aspectRatio: "16:9"
    download: true
```

The image lands in `wiro-output/`, and `steps.image.outputs.url` holds its URL.

## Model mode

Each model page on [wiro.ai/models](https://wiro.ai/models) shows the model ID (`owner/model`) and its parameters. Put the parameters in `params`, as YAML or JSON. `prompt` is a shortcut for the `prompt` parameter.

The action starts the run, checks the task every `poll-interval` seconds until it ends, and fails the step if the run fails. If `timeout` runs out or the workflow run is cancelled, it stops the task, so you don't pay for a result nobody reads. Set `cancel-on-timeout: false` to let it finish anyway. Only successful runs are billed, and the `cost` output tells you what a run cost.

LLMs run in model mode too, and their answer is in the `text` output. So is the text of models that return a text file, such as the transcript of a speech-to-text model.

### Local files as model inputs

Models that take images, audio, video or documents accept a public URL in `params`, or a file from the workspace through `files`. `files` maps each file parameter to a path:

```yaml
- uses: wiroai/wiro-action@v1
  with:
    api-key: ${{ secrets.WIRO_API_KEY }}
    model: wiro/remove-background
    files: |
      inputImage: assets/product.png
    download: true
```

The action reads the model's parameter list and uploads each file in the form that parameter expects. A parameter that takes several files accepts a list or a glob pattern.

## LLM mode

Set `mode: llm` and pick a model from the [LLM catalog](https://wiro.ai/models?categories=llm-tool-call). `files` takes paths or glob patterns, one per line:

- text files (code, diffs, Markdown, logs) are added to the message as text,
- PNG, JPEG, GIF and WebP images are sent as images,
- PDF documents are sent as files,

for models that read images and documents. `params` adds Chat Completions fields such as `max_tokens`, `reasoning_effort` or `response_format`.

```yaml
- uses: wiroai/wiro-action@v1
  id: review
  with:
    mode: llm
    api-key: ${{ secrets.WIRO_API_KEY }}
    model: openai/gpt-5-4-mini
    system: You are a careful code reviewer.
    prompt: List the three riskiest changes in this diff.
    files: pr.diff
```

## Examples

### Generate a release banner

```yaml
name: Release banner

on:
  release:
    types: [published]

permissions:
  contents: write

jobs:
  banner:
    runs-on: ubuntu-latest
    steps:
      - uses: wiroai/wiro-action@v1
        id: banner
        with:
          api-key: ${{ secrets.WIRO_API_KEY }}
          model: pruna/p-image
          prompt: >-
            A clean, wide banner for a software release named
            "${{ github.event.release.name }}", abstract shapes, soft light
          params: |
            aspectRatio: "16:9"
          download: true

      - name: Attach the banner to the release
        env:
          GH_TOKEN: ${{ github.token }}
          TAG: ${{ github.event.release.tag_name }}
          FILES: ${{ steps.banner.outputs.files }}
        run: |
          cp "$(jq -r '.[0]' <<< "$FILES")" release-banner.jpg
          gh release upload "$TAG" release-banner.jpg --repo "$GITHUB_REPOSITORY"
```

### Write alt text for changed images

```yaml
name: Alt text

on:
  pull_request:
    paths: ['**.png', '**.jpg', '**.jpeg', '**.gif', '**.webp']

permissions:
  contents: read
  pull-requests: write

jobs:
  alt-text:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0

      - name: Find the added and changed images
        id: changed
        env:
          BASE: ${{ github.event.pull_request.base.sha }}
        run: |
          {
            echo 'images<<EOF'
            git diff --name-only --diff-filter=AM "$BASE" HEAD -- '*.png' '*.jpg' '*.jpeg' '*.gif' '*.webp'
            echo 'EOF'
          } >> "$GITHUB_OUTPUT"

      - uses: wiroai/wiro-action@v1
        id: alt
        if: steps.changed.outputs.images != ''
        with:
          mode: llm
          api-key: ${{ secrets.WIRO_API_KEY }}
          model: openai/gpt-5-4-mini
          prompt: >-
            Write alt text for each image above. Answer with one line per image,
            in the form `path`: alt text, and keep each one under 125 characters.
          files: ${{ steps.changed.outputs.images }}

      - name: Comment on the pull request
        if: steps.changed.outputs.images != ''
        env:
          GH_TOKEN: ${{ github.token }}
          PR: ${{ github.event.pull_request.number }}
          ALT_TEXT: ${{ steps.alt.outputs.text }}
        run: |
          printf '### Suggested alt text\n\n%s\n' "$ALT_TEXT" |
            gh pr comment "$PR" --repo "$GITHUB_REPOSITORY" --body-file -
```

### Summarize a pull request

```yaml
name: Pull request summary

on:
  pull_request:
    types: [opened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  summary:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0

      - name: Save the diff
        env:
          BASE: ${{ github.event.pull_request.base.sha }}
        run: git diff "$BASE" HEAD -- . ':!package-lock.json' > pr.diff

      - uses: wiroai/wiro-action@v1
        id: summary
        with:
          mode: llm
          api-key: ${{ secrets.WIRO_API_KEY }}
          model: openai/gpt-5-4-mini
          system: You write short, factual pull request summaries for reviewers.
          prompt: >-
            Summarize this pull request in at most five bullet points.
            Then list anything a reviewer should look at closely.
          files: pr.diff
          params: |
            reasoning_effort: low

      - name: Comment on the pull request
        env:
          GH_TOKEN: ${{ github.token }}
          PR: ${{ github.event.pull_request.number }}
          SUMMARY: ${{ steps.summary.outputs.text }}
        run: printf '%s\n' "$SUMMARY" | gh pr comment "$PR" --repo "$GITHUB_REPOSITORY" --body-file -
```

## Inputs

| Input               | Default                  | Description                                                                                                    |
| ------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `api-key`           |                          | **Required.** Your Wiro AI project API key. Keep it in a secret.                                               |
| `api-secret`        |                          | The project's API secret, for projects that use signature authentication.                                      |
| `mode`              | `model`                  | `model` runs a model and waits for the task. `llm` sends one chat request to the LLM gateway.                  |
| `model`             |                          | **Required.** The model ID, `owner/model`, for example `pruna/p-image` or `openai/gpt-5-4-mini`.               |
| `prompt`            |                          | llm mode: the message to send (required). model mode: sent as the `prompt` parameter.                          |
| `system`            |                          | llm mode: the system prompt.                                                                                   |
| `params`            |                          | A JSON or YAML mapping. model mode: the model parameters. llm mode: extra Chat Completions fields.             |
| `files`             |                          | model mode: a mapping of file parameter to path, list or glob. llm mode: paths or glob patterns, one per line. |
| `timeout`           | `600`                    | Seconds to wait for the result.                                                                                |
| `poll-interval`     | `3`                      | model mode: seconds between task status checks.                                                                |
| `cancel-on-timeout` | `true`                   | model mode: stop the task when `timeout` runs out or the workflow run is cancelled.                            |
| `download`          | `false`                  | model mode: download the output files.                                                                         |
| `download-dir`      | `wiro-output`            | model mode: the folder for downloaded files, relative to the workspace.                                        |
| `summary`           | `true`                   | Write the result, with images and the answer, to the job summary.                                              |
| `api-url`           | `https://api.wiro.ai/v1` | The Wiro AI API base URL.                                                                                      |
| `llm-url`           | `https://llm.wiro.ai/v1` | The Wiro AI LLM gateway base URL.                                                                              |

Paths in `files` and `download-dir` are relative to the workspace. Patterns that start with `!` leave files out.

## Outputs

| Output     | Mode  | Description                                                                                                                          |
| ---------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `task-id`  | model | The Wiro AI task ID.                                                                                                                 |
| `url`      | model | The URL of the first output file.                                                                                                    |
| `urls`     | model | A JSON array with the URLs of all output files.                                                                                      |
| `files`    | model | A JSON array with the downloaded file paths, relative to the workspace.                                                              |
| `outputs`  | model | The task's outputs as a JSON array of objects with `name`, `contenttype`, `size`, `url` and, for LLMs, `content`.                    |
| `text`     | both  | The text answer: the reply in llm mode. In model mode, the answer of an LLM, or the text file a model returns, such as a transcript. |
| `cost`     | both  | The amount billed for the run, in USD.                                                                                               |
| `response` | llm   | The full Chat Completions response as JSON, for tool calls and other details.                                                        |

Read JSON outputs with `fromJSON()` in expressions, for example `fromJSON(steps.image.outputs.urls)[0]`, or with `jq` in a script.

## Authentication

For an API key only project, `api-key` is all you need. For a project that uses signature authentication, also set `api-secret`: the action signs every API request with a fresh nonce and sends `key:secret` to the LLM gateway. See [Authentication](https://wiro.ai/docs/authentication) in the docs.

## Security

- Keep the key in a secret. The action also masks it in the logs.
- Treat model output as untrusted text. Pass it to scripts through `env:`, as the examples do, and don't write `${{ steps.<id>.outputs.text }}` inside a `run:` script. See [Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions).
- Workflows started by pull requests from forks don't receive secrets, so steps that need `WIRO_API_KEY` don't run for them.

## Self-hosted runners behind a proxy

Set `NODE_USE_ENV_PROXY: 1` next to `HTTPS_PROXY` in the job's `env`, and Node.js sends the action's requests through the proxy. See [Enterprise network configuration](https://nodejs.org/en/learn/http/enterprise-network-configuration) in the Node.js docs.

## Development

```bash
npm ci
npm run build   # bundles src/ into dist/index.js
npm test        # unit tests, and dist/index.js against a mock API
npm run lint
```

`dist/` is committed, because GitHub runs the action from the repository. Run `npm run build` and commit `dist/` with every change; CI checks that it matches the source. The CI workflow also runs the action against the mock API in `test/mock-server.js`, and runs a live test when the repository has a `WIRO_API_KEY` secret.

To release, update the version in `package.json` and `src/version.js`, tag the commit `vX.Y.Z`, move the `v1` tag to the same commit, and publish a GitHub release for `vX.Y.Z`.

## More from Wiro AI

| Repository                                                                   | What it is                                                                                                                             |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [Wiro-MCP](https://github.com/wiroai/Wiro-MCP)                               | Official MCP server for Wiro AI, [`@wiro-ai/wiro-mcp` on npm](https://www.npmjs.com/package/@wiro-ai/wiro-mcp)                         |
| [Wiro-LLM](https://github.com/wiroai/Wiro-LLM)                               | Wiro AI provider for the Vercel AI SDK, [`@wiro-ai/wiro-llm` on npm](https://www.npmjs.com/package/@wiro-ai/wiro-llm)                  |
| [Wiro-Plugin](https://github.com/wiroai/Wiro-Plugin)                         | Wiro AI plugin for Cursor, Claude Code, Gemini CLI, Devin, Antigravity and Kiro                                                        |
| [Wiro-Chromium-Extension](https://github.com/wiroai/Wiro-Chromium-Extension) | Wiro AI extension for Chrome, Edge, Opera and Brave                                                                                    |
| [Wiro-Firefox-Extension](https://github.com/wiroai/Wiro-Firefox-Extension)   | Wiro AI add-on for Firefox                                                                                                             |
| [Wiro-Safari-Extension](https://github.com/wiroai/Wiro-Safari-Extension)     | Wiro AI extension for Safari on the Mac                                                                                                |
| [Swift-QuickStart](https://github.com/wiroai/Swift-QuickStart)               | WiroKit, the Wiro AI SDK for iOS                                                                                                       |
| [Kotlin-QuickStart](https://github.com/wiroai/Kotlin-QuickStart)             | WiroKit, the Wiro AI SDK for Android                                                                                                   |
| [Dart-QuickStart](https://github.com/wiroai/Dart-QuickStart)                 | Wiro AI SDK for Dart and Flutter, [`wiro` on pub.dev](https://pub.dev/packages/wiro)                                                   |
| [ReactNative-QuickStart](https://github.com/wiroai/ReactNative-QuickStart)   | Wiro AI SDK for React Native and Expo, [`@wiro-ai/wiro-react-native` on npm](https://www.npmjs.com/package/@wiro-ai/wiro-react-native) |
| [Swift-Realtime](https://github.com/wiroai/Swift-Realtime)                   | Realtime voice AI example for iOS                                                                                                      |
| [Kotlin-Realtime](https://github.com/wiroai/Kotlin-Realtime)                 | Realtime voice AI example for Android                                                                                                  |
| [Dart-Realtime](https://github.com/wiroai/Dart-Realtime)                     | Realtime voice AI example for Flutter                                                                                                  |
| [ReactNative-Realtime](https://github.com/wiroai/ReactNative-Realtime)       | Realtime voice AI example for React Native                                                                                             |
| [n8n-nodes-wiroai](https://github.com/wiroai/n8n-nodes-wiroai)               | Wiro AI nodes for n8n, [`@wiro-ai/n8n-nodes-wiroai` on npm](https://www.npmjs.com/package/@wiro-ai/n8n-nodes-wiroai)                   |
| [Wiro-Docs](https://github.com/wiroai/Wiro-Docs)                             | Source of the Wiro AI API docs                                                                                                         |

[Website](https://wiro.ai) · [Models](https://wiro.ai/models) · [Docs](https://wiro.ai/docs) · [X](https://x.com/wiroai)

## License

MIT, see [LICENSE](./LICENSE).
