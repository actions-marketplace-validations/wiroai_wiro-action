import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as core from '@actions/core';
import { InputError } from './errors.js';
import { displayPath, downloadOutputs, resolveFiles } from './files.js';
import {
  DEFAULTS,
  parseBaseUrl,
  parseBoolean,
  parseFileMapping,
  parseList,
  parseMapping,
  parseMode,
  parseModel,
  parseSeconds,
} from './inputs.js';
import { buildChatRequest, runChat } from './llm.js';
import { runModel, stopTask, TERMINAL_STATUSES } from './model.js';
import { llmSummary, modelSummary } from './summary.js';
import { createRunApi } from './wiro.js';

/** @type {import('./model.js').Logger} */
const log = {
  info: (message) => core.info(message),
  warning: (message) => core.warning(message),
  debug: (message) => core.debug(message),
};

/** @param {string} name */
const input = (name) => core.getInput(name);

/** @param {string} markdown */
async function writeSummary(markdown) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    await core.summary.addRaw(markdown, true).write();
  } catch (err) {
    core.debug(`Could not write the job summary: ${err.message}`);
  }
}

/**
 * Prints text from a model inside a log group with workflow commands turned off, so a
 * line such as `::error::` in the text stays plain text.
 * @param {string} title
 * @param {string} text
 */
function printUntrusted(title, text) {
  const token = randomUUID();
  core.startGroup(title);
  core.info(`::stop-commands::${token}`);
  core.info(text);
  core.info(`::${token}::`);
  core.endGroup();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stops the task when the workflow run is cancelled, so it is not billed. A cancel that
 * comes while the Run request is still open waits for the task to exist. The runner
 * allows about 10 seconds after SIGINT before it kills the process.
 * @param {import('./wiro.js').RunApi} api
 * @param {() => import('./model.js').TaskHandle | undefined} getHandle
 * @param {() => Promise<import('./model.js').TaskHandle> | undefined} getPending
 */
function stopTaskOnCancel(api, getHandle, getPending) {
  let stopping = false;
  /** @param {NodeJS.Signals} signal */
  const onSignal = (signal) => {
    if (stopping) return;
    stopping = true;
    const exit = () => process.exit(1);
    setTimeout(exit, 9_000).unref();
    (async () => {
      let handle = getHandle();
      const pending = getPending();
      if (!handle && pending) {
        core.warning(`Received ${signal} while the run was starting, waiting for its task to stop it.`);
        handle = await Promise.race([pending.catch(() => undefined), sleep(6_000).then(() => undefined)]);
      }
      if (!handle || (handle.status && TERMINAL_STATUSES.has(handle.status))) return;
      core.warning(`Received ${signal}, stopping task ${handle.taskId}.`);
      await stopTask(api, handle, log, { timeoutMs: 2_500 });
    })().finally(exit);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
}

/** @param {{ apiKey: string, apiSecret: string, workspace: string }} context */
async function modelMode({ apiKey, apiSecret, workspace }) {
  const model = parseModel(input('model'), 'model');
  const params = parseMapping(input('params'), 'params');
  const prompt = input('prompt');
  if (prompt) {
    if ('prompt' in params) {
      throw new InputError('The prompt is set in both `prompt` and `params`. Use one of them.');
    }
    params.prompt = prompt;
  }
  if (input('system')) {
    core.warning(
      "`system` is used in llm mode only. In model mode, set the model's own system prompt parameter in `params`.",
    );
  }

  /** @type {Record<string, string[]>} */
  const files = {};
  for (const [id, patterns] of Object.entries(parseFileMapping(input('files')))) {
    files[id] = await resolveFiles(patterns, workspace, `files.${id}`);
  }

  const timeoutMs = parseSeconds(input('timeout'), 'timeout', DEFAULTS.timeout) * 1000;
  const pollMs = parseSeconds(input('poll-interval'), 'poll-interval', DEFAULTS['poll-interval']) * 1000;
  const cancelOnTimeout = parseBoolean(input('cancel-on-timeout'), 'cancel-on-timeout', DEFAULTS['cancel-on-timeout']);
  const download = parseBoolean(input('download'), 'download', DEFAULTS.download);
  const downloadDir = path.resolve(workspace, input('download-dir') || DEFAULTS['download-dir']);
  const summary = parseBoolean(input('summary'), 'summary', DEFAULTS.summary);
  const apiUrl = parseBaseUrl(input('api-url'), 'api-url', DEFAULTS['api-url']);

  const api = createRunApi({ apiUrl, apiKey, apiSecret });
  /** @type {import('./model.js').TaskHandle | undefined} */
  let handle;
  /** @type {Promise<import('./model.js').TaskHandle> | undefined} */
  let pending;
  const unwatch = cancelOnTimeout
    ? stopTaskOnCancel(
        api,
        () => handle,
        () => pending,
      )
    : () => {};
  let result;
  try {
    result = await runModel({
      api,
      model,
      params,
      files,
      timeoutMs,
      pollMs,
      cancelOnTimeout,
      log,
      onSubmit: (submitting) => {
        pending = submitting;
      },
      onTask: (started) => {
        handle = started;
        core.setSecret(started.token);
        core.setOutput('task-id', started.taskId);
      },
    });
  } finally {
    unwatch();
  }

  core.setOutput('outputs', JSON.stringify(result.outputs));
  core.setOutput('urls', JSON.stringify(result.urls));
  core.setOutput('url', result.urls[0] ?? '');
  core.setOutput('text', result.text);
  core.setOutput('cost', result.cost);

  let saved = [];
  if (download && result.urls.length) {
    const paths = await downloadOutputs(result.outputs, downloadDir);
    saved = paths.map((file) => displayPath(file, workspace));
  }
  core.setOutput('files', JSON.stringify(saved));

  core.info(`Task ${result.handle.taskId} succeeded. Cost: $${result.cost || '0'}.`);
  for (const url of result.urls) core.info(`Output: ${url}`);
  for (const file of saved) core.info(`Saved: ${file}`);
  if (result.text) printUntrusted('Text', result.text);

  if (summary) {
    await writeSummary(
      modelSummary({
        modelId: model.id,
        taskId: result.handle.taskId,
        cost: result.cost,
        elapsedSeconds: result.elapsedSeconds,
        outputs: result.outputs,
        text: result.text,
        files: saved,
      }),
    );
  }
}

/** @param {{ apiKey: string, apiSecret: string, workspace: string }} context */
async function llmMode({ apiKey, apiSecret, workspace }) {
  const model = parseModel(input('model'), 'llm');
  const prompt = input('prompt');
  if (!prompt) throw new InputError('`prompt` is required in llm mode.');
  const system = input('system');
  const extra = parseMapping(input('params'), 'params');
  const patterns = parseList(input('files'), 'files');
  const files = patterns.length ? await resolveFiles(patterns, workspace, '`files`') : [];
  const timeoutMs = parseSeconds(input('timeout'), 'timeout', DEFAULTS.timeout) * 1000;
  const summary = parseBoolean(input('summary'), 'summary', DEFAULTS.summary);
  const llmUrl = parseBaseUrl(input('llm-url'), 'llm-url', DEFAULTS['llm-url']);
  if (parseBoolean(input('download'), 'download', DEFAULTS.download)) {
    core.warning('`download` is used in model mode only.');
  }

  const body = await buildChatRequest({ model: model.id, prompt, system, extra, files, workspace });
  if (files.length) {
    printUntrusted(`Attached ${files.length} file(s)`, files.map((file) => displayPath(file, workspace)).join('\n'));
  }
  const result = await runChat({ llmUrl, apiKey, apiSecret, body, timeoutMs, log });

  core.setOutput('text', result.text);
  core.setOutput('cost', result.cost);
  core.setOutput('response', JSON.stringify(result.response));

  core.info(`${model.id} answered. Cost: $${result.cost || '0'}.`);
  if (result.text) printUntrusted('Answer', result.text);
  if (summary) {
    await writeSummary(
      llmSummary({
        modelId: model.id,
        cost: result.cost,
        finishReason: result.finishReason,
        usage: result.usage,
        text: result.text,
      }),
    );
  }
}

export async function run() {
  try {
    const apiKey = core.getInput('api-key');
    if (!apiKey) {
      throw new InputError(
        '`api-key` is empty. Pass it from a secret, for example `api-key: ${{ secrets.WIRO_API_KEY }}`. ' +
          "Workflows started by pull requests from forks, or by Dependabot, don't receive repository secrets.",
      );
    }
    core.setSecret(apiKey);
    const apiSecret = core.getInput('api-secret');
    if (apiSecret) core.setSecret(apiSecret);

    const mode = parseMode(input('mode'));
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    if (mode === 'llm') await llmMode({ apiKey, apiSecret, workspace });
    else await modelMode({ apiKey, apiSecret, workspace });
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}
