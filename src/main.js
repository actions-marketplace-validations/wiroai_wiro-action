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
  parseMaxCost,
  parseMode,
  parseModel,
  parseSeconds,
} from './inputs.js';
import { buildChatRequest, fetchModelInfo, runChat } from './llm.js';
import { formatCost, readTool, requiredDefaults, runModel, stopTask, TERMINAL_STATUSES } from './model.js';
import { describePart, enforceMaxCost, estimateChat, formatUsd, priceModelRun, sumEstimate } from './pricing.js';
import { llmSummary, modelSummary, workflowSummary } from './summary.js';
import { createRunApi } from './wiro.js';
import {
  checkWorkflowInputs,
  estimateWorkflowCost,
  parseWorkflowSlug,
  RUN_GOES_ON,
  runWorkflow,
  startValues,
  TERMINAL_RUN_STATUSES,
} from './workflow.js';
import { oneLine } from './text.js';

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
 * Stops the run when the workflow run is cancelled, so it is not billed. A cancel that
 * comes while the start request is still open waits for the run to exist. The runner
 * allows about 10 seconds after SIGINT before it kills the process.
 * @template T
 * @param {{ current: () => T | undefined, pending: () => Promise<T> | undefined, isOver: (handle: T) => boolean, stop: (handle: T) => Promise<unknown>, name: (handle: T) => string }} target
 */
function stopOnCancel(target) {
  let stopping = false;
  /** @param {NodeJS.Signals} signal */
  const onSignal = (signal) => {
    if (stopping) return;
    stopping = true;
    const exit = () => process.exit(1);
    setTimeout(exit, 9_000).unref();
    (async () => {
      let handle = target.current();
      const pending = target.pending();
      if (!handle && pending) {
        core.warning(`Received ${signal} while the run was starting, waiting for it to stop it.`);
        handle = await Promise.race([pending.catch(() => undefined), sleep(6_000).then(() => undefined)]);
      }
      if (!handle || target.isOver(handle)) return;
      core.warning(`Received ${signal}, stopping ${target.name(handle)}.`);
      await target.stop(handle);
    })().finally(exit);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
}

/**
 * Logs an estimate, sets `estimated-cost`, and enforces `max-cost`.
 * @param {import('./pricing.js').Estimate & { outputTokens?: number, inputTokens?: number }} estimate
 * @param {number | undefined} maxCost
 * @param {string} what
 * @param {{ upTo?: boolean }} [options]
 */
function reportEstimate(estimate, maxCost, what, { upTo = false } = {}) {
  const known = estimate.value !== null;
  core.setOutput('estimated-cost', known ? formatCost(estimate.value) : '');
  if (known) {
    let line = `Estimated cost: ${upTo ? 'up to ' : ''}$${formatUsd(estimate.value ?? 0)}`;
    if (estimate.inputTokens !== undefined) {
      line += ` (about ${estimate.inputTokens} input tokens, up to ${estimate.outputTokens} output tokens)`;
    }
    core.info(`${line}.`);
  } else {
    core.info('Estimated cost: not known before the run.');
  }
  for (const part of estimate.parts) core.info(`  ${describePart(part)}`);
  enforceMaxCost(estimate, maxCost, what);
  if (maxCost !== undefined && estimate.parts.some((part) => part.llm && part.price.kind !== 'priced')) {
    core.warning('LLM token use is billed when the run ends and is not part of the estimate checked against max-cost.');
  }
}

/** @param {string} value */
function promptInto(params, value) {
  if (!value) return;
  if ('prompt' in params) throw new InputError('The prompt is set in both `prompt` and `params`. Use one of them.');
  params.prompt = value;
}

/** Inputs that model and workflow modes read the same way. */
function taskOptions(workspace) {
  return {
    timeoutMs: parseSeconds(input('timeout'), 'timeout', DEFAULTS.timeout) * 1000,
    pollMs: parseSeconds(input('poll-interval'), 'poll-interval', DEFAULTS['poll-interval']) * 1000,
    cancelOnTimeout: parseBoolean(input('cancel-on-timeout'), 'cancel-on-timeout', DEFAULTS['cancel-on-timeout']),
    download: parseBoolean(input('download'), 'download', DEFAULTS.download),
    downloadDir: path.resolve(workspace, input('download-dir') || DEFAULTS['download-dir']),
    summary: parseBoolean(input('summary'), 'summary', DEFAULTS.summary),
    apiUrl: parseBaseUrl(input('api-url'), 'api-url', DEFAULTS['api-url']),
    maxCost: parseMaxCost(input('max-cost')),
  };
}

/**
 * @param {string} workspace
 * @returns {Promise<Record<string, string[]>>}
 */
async function fileMapping(workspace) {
  /** @type {Record<string, string[]>} */
  const files = {};
  for (const [id, patterns] of Object.entries(parseFileMapping(input('files')))) {
    files[id] = await resolveFiles(patterns, workspace, `files.${id}`);
  }
  return files;
}

/**
 * Downloads the files and sets the `files` output.
 * @param {boolean} download
 * @param {Array<{ name?: string, url?: string }>} outputs
 * @param {string} downloadDir
 * @param {string} workspace
 */
async function saveFiles(download, outputs, downloadDir, workspace) {
  let saved = [];
  if (download && outputs.some((output) => output.url)) {
    const paths = await downloadOutputs(outputs, downloadDir);
    saved = paths.map((file) => displayPath(file, workspace));
  }
  core.setOutput('files', JSON.stringify(saved));
  return saved;
}

/** @param {{ apiKey: string, apiSecret: string, workspace: string }} context */
async function modelMode({ apiKey, apiSecret, workspace }) {
  const model = parseModel(input('model'), 'model');
  const params = parseMapping(input('params'), 'params');
  promptInto(params, input('prompt'));
  if (input('system')) {
    core.warning(
      "`system` is used in llm mode only. In model mode, set the model's own system prompt parameter in `params`.",
    );
  }
  const files = await fileMapping(workspace);
  const options = taskOptions(workspace);

  const api = createRunApi({ apiUrl: options.apiUrl, apiKey, apiSecret });
  const tool = await readTool(api, model, log, 'The price is not checked before the run.');
  if (tool) {
    const filled = requiredDefaults(tool, params, files);
    if (Object.keys(filled).length) {
      Object.assign(params, filled);
      const list = Object.entries(filled).map(([id, value]) => `${id}: ${JSON.stringify(value)}`);
      core.info(`Required parameters you left out get their defaults: ${list.join(', ')}.`);
    }
  }
  const price = tool ? priceModelRun(tool, params, files) : { kind: 'unknown' };
  reportEstimate(sumEstimate([{ label: model.id, tool, price }]), options.maxCost, 'The run');

  /** @type {import('./model.js').TaskHandle | undefined} */
  let handle;
  /** @type {Promise<import('./model.js').TaskHandle> | undefined} */
  let pending;
  const unwatch = options.cancelOnTimeout
    ? stopOnCancel({
        current: () => handle,
        pending: () => pending,
        isOver: (task) => Boolean(task.status && TERMINAL_STATUSES.has(task.status)),
        stop: (task) => stopTask(api, task, log, { timeoutMs: 2_500 }),
        name: (task) => `task ${task.taskId}`,
      })
    : () => {};
  let result;
  try {
    result = await runModel({
      api,
      model,
      params,
      files,
      timeoutMs: options.timeoutMs,
      pollMs: options.pollMs,
      cancelOnTimeout: options.cancelOnTimeout,
      log,
      tool: tool ?? undefined,
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
  const saved = await saveFiles(options.download, result.outputs, options.downloadDir, workspace);

  core.info(`Task ${result.handle.taskId} succeeded. Cost: $${result.cost || '0'}.`);
  for (const url of result.urls) core.info(`Output: ${oneLine(url)}`);
  for (const file of saved) core.info(`Saved: ${file}`);
  if (result.text) printUntrusted('Text', result.text);

  if (options.summary) {
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
async function workflowMode({ apiKey, apiSecret, workspace }) {
  const slug = parseWorkflowSlug(input('workflow'));
  const params = parseMapping(input('params'), 'params');
  promptInto(params, input('prompt'));
  if (input('model')) core.warning('`model` is not used in workflow mode; the workflow chooses its models.');
  if (input('system')) core.warning('`system` is used in llm mode only.');
  const files = await fileMapping(workspace);
  const options = taskOptions(workspace);

  const api = createRunApi({ apiUrl: options.apiUrl, apiKey, apiSecret });
  const detail = await api.workflowDetail(slug);
  const workflow = Array.isArray(detail?.workflow) ? detail.workflow[0] : undefined;
  if (!workflow) throw new InputError(`Workflow/Detail returned nothing for ${slug}.`);
  checkWorkflowInputs(workflow, slug, params, Object.keys(files));
  core.info(`Workflow: ${workflow.title ? `${oneLine(workflow.title)} (${slug})` : slug}`);

  // Files are uploaded after the price check, so a refused run uploads nothing.
  /** @type {Record<string, unknown>} */
  const fileStandIns = {};
  for (const [field, paths] of Object.entries(files)) fileStandIns[field] = paths.length === 1 ? paths[0] : paths;
  const estimate = await estimateWorkflowCost(
    api,
    workflow,
    startValues(workflow.contents, { ...params, ...fileStandIns }),
    log,
  );
  reportEstimate(estimate, options.maxCost, 'The workflow run');

  /** @type {Record<string, unknown>} */
  const runInput = { ...params };
  for (const [field, paths] of Object.entries(files)) {
    const urls = [];
    for (const file of paths) urls.push((await api.uploadFile(file)).url);
    runInput[field] = urls.length === 1 ? urls[0] : urls;
    core.info(`Uploaded ${oneLine(paths.map((file) => displayPath(file, workspace)).join(', '))} for \`${field}\`.`);
  }

  /** @type {import('./workflow.js').RunHandle | undefined} */
  let handle;
  // A started workflow run goes on when this job is cancelled; say so before exiting.
  const onSignal = (signal) => {
    const over = handle?.status && TERMINAL_RUN_STATUSES.has(handle.status);
    if (handle && !over) core.warning(`Received ${signal}. ${RUN_GOES_ON}`);
    process.exit(1);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let result;
  try {
    result = await runWorkflow({
      api,
      slug,
      input: runInput,
      timeoutMs: options.timeoutMs,
      pollMs: options.pollMs,
      log,
      onRun: (started) => {
        handle = started;
        core.setSecret(started.token);
        core.setOutput('run-token', started.token);
      },
    });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  core.setOutput('outputs', JSON.stringify(result.results));
  core.setOutput('urls', JSON.stringify(result.urls));
  core.setOutput('url', result.urls[0] ?? '');
  core.setOutput('text', result.text);
  core.setOutput('cost', result.cost);
  const saved = await saveFiles(options.download, result.files, options.downloadDir, workspace);

  core.info(`The run of ${slug} completed. Cost: $${result.cost || '0'}.`);
  for (const url of result.urls) core.info(`Output: ${oneLine(url)}`);
  for (const file of saved) core.info(`Saved: ${file}`);
  if (result.text) printUntrusted('Text', result.text);

  if (options.summary) {
    await writeSummary(
      workflowSummary({
        slug,
        title: workflow.title,
        cost: result.cost,
        elapsedSeconds: result.elapsedSeconds,
        nodes: result.nodes,
        results: result.results,
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
  const maxCost = parseMaxCost(input('max-cost'));
  if (parseBoolean(input('download'), 'download', DEFAULTS.download)) {
    core.warning('`download` is used in model and workflow modes only.');
  }

  const body = await buildChatRequest({ model: model.id, prompt, system, extra, files, workspace });
  if (files.length) {
    printUntrusted(`Attached ${files.length} file(s)`, files.map((file) => displayPath(file, workspace)).join('\n'));
  }
  const info = await fetchModelInfo({ llmUrl, apiKey, apiSecret, model: model.id });
  reportEstimate(estimateChat({ body, model: info }), maxCost, 'The request', { upTo: true });

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

    const mode = parseMode(input('mode'), { workflow: input('workflow') });
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    if (mode === 'llm') await llmMode({ apiKey, apiSecret, workspace });
    else if (mode === 'workflow') await workflowMode({ apiKey, apiSecret, workspace });
    else await modelMode({ apiKey, apiSecret, workspace });
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}
