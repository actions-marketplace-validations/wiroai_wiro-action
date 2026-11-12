# Changelog

## 1.1.0 (2026-11-11)

- **Workflow mode.** Run one of your Wiro AI workflows by its link or full slug. `params` sets its inputs and `files` uploads local files for them. The action checks the inputs before it starts, logs each step, returns the End node's results in `outputs`, `urls` and `text`, and downloads files. The new `run-token` output holds the run's token.
- **Cost limit.** The action estimates the price before every run, logs it and sets the new `estimated-cost` output. A run whose estimate is above `max-cost`, or whose price can't be confirmed under it, does not start.
- **Required parameters.** In model mode, a required parameter you leave out, such as an output format, gets the default the model's form on wiro.ai starts with. The log lists them.
- New README examples: a release banner with a short video, the release notes read aloud, a README translation in a pull request, a social share card and a workflow run.
- `mode` can be left out when `workflow` is set, and `model` is no longer marked required, since workflow mode doesn't use it.

## 1.0.0 (2026-11-11)

- First release: model mode and llm mode, local files as inputs, downloads, signature authentication, the job summary, and stopping the task on timeout or cancellation.
