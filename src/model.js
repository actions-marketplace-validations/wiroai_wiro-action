import { openAsBlob } from 'node:fs';
import path from 'node:path';
import { InputError, TaskError, WiroApiError } from './errors.js';
import { fetchText, isTextOutput, MAX_TEXT_OUTPUT_BYTES, mimeType } from './files.js';

/** Statuses that end a task. Everything else, `task_error` included, means keep waiting. */
export const TERMINAL_STATUSES = new Set(['task_postprocess_end', 'task_cancel']);

/** Statuses before a GPU is assigned, when Task/Cancel applies instead of Task/Kill. */
const QUEUED_STATUSES = new Set(['task_queue', 'task_accept', 'task_preprocess_start', 'task_preprocess_end']);

const FILE_TYPES = new Set(['fileinput', 'multifileinput', 'combinefileinput']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @typedef {{ info: (message: string) => void, warning: (message: string) => void, debug: (message: string) => void }} Logger
 * @typedef {{ taskId: string, token: string, status?: string }} TaskHandle
 * @typedef {{ id: string, owner: string, project: string }} ModelId
 */

/**
 * The field that carries URLs for a file parameter. Multipart requests send it empty
 * next to an uploaded file. See https://wiro.ai/docs/model-parameters
 * @param {string} id
 * @param {string | undefined} type
 */
export function urlFieldFor(id, type) {
  if (type === 'fileinput') return `${id}Url`;
  if (type === 'multifileinput') {
    return id.endsWith('Multiple') ? `${id.slice(0, -'Multiple'.length)}UrlMultiple` : `${id}Url`;
  }
  return undefined;
}

/** @param {unknown} value */
function formValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Reads the model's parameter types from Tool/Detail. Returns null when they can't be read.
 * @param {import('./wiro.js').RunApi} api
 * @param {ModelId} model
 * @param {Logger} log
 * @returns {Promise<Map<string, string> | null>}
 */
export async function readParameterTypes(api, model, log) {
  try {
    const detail = await api.toolDetail(model.owner, model.project);
    const tool = Array.isArray(detail?.tool) ? detail.tool[0] : undefined;
    if (!tool) return null;
    const types = new Map();
    for (const group of Array.isArray(tool.parameters) ? tool.parameters : []) {
      for (const item of Array.isArray(group?.items) ? group.items : []) {
        if (item?.id) types.set(String(item.id), String(item.type ?? ''));
      }
    }
    return types;
  } catch (err) {
    log.warning(`Could not read the parameters of ${model.id} (${err.message}). Files are sent as given.`);
    return null;
  }
}

/**
 * Builds the multipart body for a run with local files.
 * @param {{ params: Record<string, unknown>, files: Record<string, string[]>, types: Map<string, string> | null, model: ModelId }} options
 */
export async function buildMultipart({ params, files, types, model }) {
  const form = new FormData();
  for (const [key, value] of Object.entries(params)) {
    if (key in files) continue;
    if (Array.isArray(value) && types?.get(key) === 'combinefileinput') {
      for (const item of value) form.append(key, formValue(item));
    } else {
      form.append(key, formValue(value));
    }
  }

  for (const [id, paths] of Object.entries(files)) {
    const type = types?.get(id);
    if (types && !type) {
      const fileParams = [...types].filter(([, t]) => FILE_TYPES.has(t)).map(([name]) => `\`${name}\``);
      throw new InputError(
        `${model.id} has no parameter named \`${id}\`. ` +
          (fileParams.length ? `Its file parameters are ${fileParams.join(', ')}.` : 'It takes no files.'),
      );
    }
    if (type && !FILE_TYPES.has(type)) {
      throw new InputError(`\`${id}\` is a ${type} parameter of ${model.id}, not a file parameter.`);
    }
    if (type === 'fileinput' && paths.length > 1) {
      throw new InputError(`\`${id}\` takes one file, but ${paths.length} match.`);
    }

    const urlField = urlFieldFor(id, type);
    if (id in params && type !== 'combinefileinput') {
      throw new InputError(`\`${id}\` is set in both \`files\` and \`params\`. Use one of them.`);
    }
    if (urlField && params[urlField]) {
      throw new InputError(`\`${id}\` has a file in \`files\` and a URL in \`params.${urlField}\`. Use one of them.`);
    }

    for (const file of paths) {
      form.append(id, await openAsBlob(file, { type: mimeType(file) }), path.basename(file));
    }
    if (type === 'combinefileinput' && id in params) {
      const urls = Array.isArray(params[id]) ? params[id] : [params[id]];
      for (const url of urls) form.append(id, formValue(url));
    }
    if (urlField && !(urlField in params)) form.append(urlField, '');
  }
  return form;
}

/**
 * @param {unknown} err
 * @param {ModelId} model
 */
function explainRunError(err, model) {
  if (!(err instanceof WiroApiError)) return err;
  let message = err.message;
  if (/slug-owner-project-not-exist/.test(message)) {
    message = `Wiro AI has no model \`${model.id}\`. Model IDs are on each model's page at https://wiro.ai/models.`;
  } else if (/tool-not-accessible/.test(message)) {
    message = `\`${model.id}\` can't be run with this project's API key.`;
  } else if (err.code === 97) {
    message += '. Add funds at https://wiro.ai/panel/billing.';
  } else if (err.status === 401) {
    message += ' Check `api-key`, and `api-secret` for projects that use signature authentication.';
  }
  return new WiroApiError(message, { code: err.code, status: err.status });
}

/**
 * Starts the run. A concurrency refusal (code 96) creates no task, so it is tried again
 * with growing waits until the deadline.
 * @param {import('./wiro.js').RunApi} api
 * @param {ModelId} model
 * @param {object | FormData} body
 * @param {number} deadline
 * @param {Logger} log
 * @param {number} [firstWaitMs]
 */
export async function submitRun(api, model, body, deadline, log, firstWaitMs = 5_000) {
  let wait = firstWaitMs;
  for (;;) {
    try {
      const remaining = deadline - Date.now();
      const data = await api.run(model.owner, model.project, body, Math.max(30_000, Math.min(remaining, 300_000)));
      if (!data?.taskid || !data?.socketaccesstoken) {
        throw new WiroApiError('The Run API answered without a task ID.');
      }
      return { taskId: String(data.taskid), token: String(data.socketaccesstoken) };
    } catch (err) {
      if (err instanceof WiroApiError && err.code === 96 && Date.now() + wait < deadline) {
        log.info(`${err.message} Trying again in ${Math.round(wait / 1000)} s.`);
        await sleep(wait);
        wait = Math.min(wait * 2, 60_000);
        continue;
      }
      throw explainRunError(err, model);
    }
  }
}

/**
 * Stops a task: Task/Cancel while it is queued, Task/Kill once it runs, the other one if
 * the first is refused.
 * @param {import('./wiro.js').RunApi} api
 * @param {TaskHandle} handle
 * @param {Logger} log
 */
export async function stopTask(api, handle, log) {
  const cancel = ['Task/Cancel', () => api.cancel(handle.taskId)];
  const kill = ['Task/Kill', () => api.kill(handle.token)];
  const queued = !handle.status || QUEUED_STATUSES.has(handle.status);
  for (const [name, attempt] of queued ? [cancel, kill] : [kill, cancel]) {
    try {
      await attempt();
      log.info(`Stopped task ${handle.taskId} with ${name}.`);
      return true;
    } catch (err) {
      log.debug(`${name} for task ${handle.taskId} failed: ${err.message}`);
    }
  }
  return false;
}

/**
 * Polls Task/Detail until the task ends (https://wiro.ai/docs/tasks), or the deadline passes.
 * @param {import('./wiro.js').RunApi} api
 * @param {TaskHandle} handle
 * @param {{ deadline: number, pollMs: number, timeoutMs: number, cancelOnTimeout: boolean, log: Logger }} options
 */
export async function waitForTask(api, handle, { deadline, pollMs, timeoutMs, cancelOnTimeout, log }) {
  let failures = 0;
  let refusals = 0;
  for (;;) {
    let detail;
    try {
      detail = await api.taskDetail(handle.token);
      failures = 0;
      refusals = 0;
    } catch (err) {
      if (err instanceof WiroApiError && (err.status === 401 || err.status === 403)) throw err;
      if (err instanceof WiroApiError && !err.retryable) {
        refusals += 1;
        if (refusals >= 5) throw err;
      } else {
        failures += 1;
      }
      const note = `Task/Detail failed (${err.message}); trying again.`;
      if (failures === 3) log.warning(note);
      else log.debug(note);
    }

    const task = Array.isArray(detail?.tasklist) ? detail.tasklist[0] : undefined;
    if (task?.status) {
      if (task.status !== handle.status) {
        handle.status = task.status;
        log.info(`Status: ${task.status}`);
      }
      if (TERMINAL_STATUSES.has(task.status)) return task;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
  }

  let message = `Task ${handle.taskId} did not finish within ${Math.round(timeoutMs / 1000)} s (last status: ${handle.status ?? 'unknown'}).`;
  if (cancelOnTimeout) {
    const stopped = await stopTask(api, handle, log);
    message += stopped ? ' It was stopped.' : ' It could not be stopped, so it may still finish.';
  } else {
    message += ' It is still running.';
  }
  throw new TaskError(message);
}

/**
 * The outputs without internal fields: name, contenttype, size, url, and content for LLM text.
 * @param {any} task
 */
export function normalizeOutputs(task) {
  const list = Array.isArray(task?.outputs) ? task.outputs : [];
  return list
    .filter((output) => output && typeof output === 'object')
    .map((output) => {
      /** @type {{ name?: string, contenttype?: string, size?: number | string, url?: string, content?: unknown }} */
      const item = {};
      if (output.name !== undefined && output.name !== null) item.name = String(output.name);
      if (output.contenttype !== undefined && output.contenttype !== null)
        item.contenttype = String(output.contenttype);
      if (output.size !== undefined && output.size !== null && output.size !== '') {
        const size = Number(output.size);
        item.size = Number.isFinite(size) ? size : output.size;
      }
      if (typeof output.url === 'string' && output.url) item.url = output.url;
      if (output.content !== undefined) item.content = output.content;
      return item;
    });
}

/**
 * The text a task returned. LLMs give their answer segments; models that return text
 * instead of files give their text output. Models that return files give no text.
 * @param {any} task
 * @param {ReturnType<typeof normalizeOutputs>} outputs
 */
export function extractText(task, outputs) {
  const debugOutput = String(task?.debugoutput ?? '').trim();
  const raw = outputs.find(
    (output) => output.contenttype === 'raw' && output.content && typeof output.content === 'object',
  );
  if (raw) {
    const content = /** @type {any} */ (raw.content);
    const segments = Array.isArray(content.segments) ? content.segments : [];
    const answer = segments
      .filter((segment) => segment?.type === 'answer' && typeof segment.text === 'string')
      .map((segment) => segment.text)
      .join('')
      .trim();
    if (answer) return answer;
    if (Array.isArray(content.answer)) {
      const joined = content.answer
        .filter((part) => typeof part === 'string')
        .join('')
        .trim();
      if (joined) return joined;
    }
    if (typeof content.raw === 'string' && content.raw.trim()) return content.raw.trim();
    return debugOutput;
  }
  if (outputs.some((output) => output.url)) return '';
  return debugOutput;
}

/** @param {any} task */
export function finishReason(task) {
  const raw = (Array.isArray(task?.outputs) ? task.outputs : []).find(
    (output) => output?.contenttype === 'raw' && output?.content && typeof output.content === 'object',
  );
  return typeof raw?.content?.finishreason === 'string' ? raw.content.finishreason : undefined;
}

/**
 * A USD amount as a plain decimal string, for example `0.00351`.
 * @param {unknown} value
 */
export function formatCost(value) {
  if (value === undefined || value === null || value === '') return '';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '';
  if (amount === 0) return '0';
  return amount.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
}

/** @param {string} text @param {number} max */
function tail(text, max) {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

/**
 * Throws unless the task succeeded: `pexit` "0" after `task_postprocess_end`.
 * @param {any} task
 * @param {TaskHandle} handle
 */
export function assertSucceeded(task, handle) {
  if (task.status === 'task_cancel') {
    throw new TaskError(`Task ${handle.taskId} was cancelled.`);
  }
  if (String(task.pexit) !== '0') {
    const detail = String(task.debugerror ?? '').trim();
    throw new TaskError(
      `The model run failed (task ${handle.taskId}, exit code ${task.pexit || 'unknown'})` +
        (detail ? `: ${tail(detail, 1500)}` : '.'),
    );
  }
}

/**
 * Runs a model and waits for it: Run, then Task/Detail until the task ends.
 * @param {object} options
 * @param {import('./wiro.js').RunApi} options.api
 * @param {ModelId} options.model
 * @param {Record<string, unknown>} options.params
 * @param {Record<string, string[]>} options.files absolute paths per file parameter
 * @param {number} options.timeoutMs
 * @param {number} options.pollMs
 * @param {boolean} options.cancelOnTimeout
 * @param {Logger} options.log
 * @param {(handle: TaskHandle) => void} [options.onTask]
 */
export async function runModel({ api, model, params, files, timeoutMs, pollMs, cancelOnTimeout, log, onTask }) {
  const deadline = Date.now() + timeoutMs;

  /** @type {object | FormData} */
  let body = params;
  if (Object.keys(files).length) {
    const types = await readParameterTypes(api, model, log);
    body = await buildMultipart({ params, files, types, model });
  }

  const handle = await submitRun(api, model, body, deadline, log);
  onTask?.(handle);
  log.info(`Started task ${handle.taskId} on ${model.id}.`);

  const task = await waitForTask(api, handle, { deadline, pollMs, timeoutMs, cancelOnTimeout, log });
  assertSucceeded(task, handle);

  const outputs = normalizeOutputs(task);
  const reason = finishReason(task);
  if (reason === 'length') {
    log.warning('The answer reached the token limit and may be cut short.');
  } else if (reason === 'content_filter' || reason === 'error') {
    log.warning(`The model stopped early (finish reason: ${reason}).`);
  }
  return {
    handle,
    task,
    outputs,
    urls: outputs.filter((output) => output.url).map((output) => /** @type {string} */ (output.url)),
    text: extractText(task, outputs) || (await readTextOutputs(outputs, log)),
    cost: formatCost(task.totalcost),
    elapsedSeconds: Number(task.elapsedseconds) || undefined,
  };
}

/**
 * The contents of text output files, such as the transcript of a speech-to-text model.
 * LLM answers come from extractText instead.
 * @param {ReturnType<typeof normalizeOutputs>} outputs
 * @param {Logger} log
 */
export async function readTextOutputs(outputs, log) {
  if (outputs.some((output) => output.contenttype === 'raw')) return '';
  const parts = [];
  for (const output of outputs) {
    if (!output.url || !isTextOutput(output)) continue;
    if (typeof output.size === 'number' && output.size > MAX_TEXT_OUTPUT_BYTES) continue;
    try {
      parts.push((await fetchText(output.url)).trim());
    } catch (err) {
      log.warning(`Could not read the text output ${output.name ?? output.url}: ${err.message}`);
    }
  }
  return parts.filter(Boolean).join('\n\n');
}
