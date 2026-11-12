// Workflow mode: run a saved Wiro AI workflow and collect what its End node shows.
// See https://wiro.ai/docs/workflows
import { InputError, TaskError, WiroApiError } from './errors.js';
import { formatCost, normalizeOutputs, rawAnswer, REFUSAL_LIMIT_MS, withConcurrencyRetry } from './model.js';
import { priceStep, roundUsd, runValues, sumEstimate } from './pricing.js';
import { oneLine } from './text.js';

/** Run statuses that end a run. */
export const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'stopped', 'cancelled']);

const FULL_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]*-[A-Za-z0-9]{5}$/;

/** Stands in for a value an earlier step produces, which is not known before the run. */
const EARLIER_STEP = Object.freeze({ earlierStep: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @typedef {import('./model.js').Logger} Logger
 * @typedef {{ token: string, status?: string, nodes?: any[] }} RunHandle
 */

/**
 * The full slug of a workflow, from the slug itself or a link to its page on wiro.ai.
 * @param {string} value
 */
export function parseWorkflowSlug(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new InputError(
      '`workflow` is required in workflow mode: the full slug, such as `product-ad-a1B2c`, or the link to the workflow on wiro.ai.',
    );
  }
  let candidates = [text];
  if (/^https?:\/\//i.test(text)) {
    try {
      candidates = new URL(text).pathname.split('/').filter(Boolean).reverse();
    } catch {
      candidates = [];
    }
  }
  const slug = candidates.map((part) => decodeURIComponent(part)).find((part) => FULL_SLUG.test(part));
  if (!slug) {
    throw new InputError(
      `\`workflow\` must be a full workflow slug, such as \`product-ad-a1B2c\`, or its link on wiro.ai, not \`${text}\`.`,
    );
  }
  return slug;
}

/** @param {string[]} names */
const listNames = (names) => names.map((name) => `\`${name}\``).join(', ');

/**
 * The workflow's graph, whether Workflow/Detail sent it as an object or a JSON string.
 * @param {any} contents
 */
export function graphOf(contents) {
  if (typeof contents === 'string') {
    try {
      return JSON.parse(contents);
    } catch {
      return {};
    }
  }
  return contents && typeof contents === 'object' ? contents : {};
}

/**
 * Checks the inputs against the workflow's Start fields before anything is sent.
 * @param {any} workflow Workflow/Detail `workflow[0]`
 * @param {string} slug
 * @param {Record<string, unknown>} params
 * @param {string[]} fileFields
 */
export function checkWorkflowInputs(workflow, slug, params, fileFields) {
  const schema = graphOf(workflow?.contents)?.schema?.input;
  const known = schema && typeof schema === 'object' ? Object.keys(schema) : null;
  const given = [...new Set([...Object.keys(params), ...fileFields])];
  for (const field of fileFields) {
    if (field in params) throw new InputError(`\`${field}\` is set in both \`files\` and \`params\`. Use one of them.`);
  }
  if (known) {
    const unknown = given.filter((name) => !known.includes(name));
    if (unknown.length) {
      throw new InputError(
        `${slug} has no input named ${listNames(unknown)}. ` +
          (known.length ? `Its inputs are ${listNames(known)}.` : 'It takes no inputs.'),
      );
    }
  }
  const required = Array.isArray(workflow?.requiredinputs) ? workflow.requiredinputs.map(String) : [];
  const missing = required.filter((name) => !given.includes(name));
  if (missing.length) {
    throw new InputError(`${slug} needs a value for ${listNames(missing)}. Set it in \`params\` or \`files\`.`);
  }
}

/**
 * The value each Start field has in a run: the given value, else the saved one, else the default.
 * @param {any} contents
 * @param {Record<string, unknown>} given
 */
export function startValues(contents, given) {
  const graph = graphOf(contents);
  const schema = graph?.schema?.input && typeof graph.schema.input === 'object' ? graph.schema.input : {};
  const saved =
    graph?.metadata?.input?.values && typeof graph.metadata.input.values === 'object'
      ? graph.metadata.input.values
      : {};
  /** @type {Record<string, unknown>} */
  const values = {};
  for (const [key, field] of Object.entries(schema)) {
    if (given[key] !== undefined) values[key] = given[key];
    else if (saved[key] !== undefined && saved[key] !== '') values[key] = saved[key];
    else if (field?.defaultValue !== undefined && field.defaultValue !== '') values[key] = field.defaultValue;
  }
  for (const [key, value] of Object.entries(given)) if (!(key in values)) values[key] = value;
  return values;
}

/**
 * The steps that lead to the End node, each after the steps it depends on. Only these run.
 * @param {Record<string, any>} nodes
 */
export function stepsToRun(nodes) {
  const seen = new Set();
  const order = [];
  const visit = (id) => {
    if (seen.has(id) || id === 'input') return;
    seen.add(id);
    for (const dependency of Array.isArray(nodes?.[id]?.depends) ? nodes[id].depends : []) visit(String(dependency));
    if (id !== 'output' && nodes?.[id]) order.push(id);
  };
  visit('output');
  return order;
}

/**
 * A step input with Start field references filled in and earlier step outputs marked.
 * @param {unknown} value
 * @param {Record<string, unknown>} start
 * @returns {unknown}
 */
export function resolveStepValue(value, start) {
  if (typeof value === 'string' && value.startsWith('$input.')) return start[value.slice('$input.'.length)];
  if (typeof value === 'string' && value.startsWith('$node-')) return EARLIER_STEP;
  if (Array.isArray(value)) {
    // A Start field that holds a list adds its items, not one item for the whole list.
    return value
      .flatMap((item) => {
        const resolved = resolveStepValue(item, start);
        return Array.isArray(resolved) ? resolved : [resolved];
      })
      .filter((item) => item !== undefined && item !== '');
  }
  return value;
}

/**
 * The End node's fields: result name to reference. A workflow read from outside its
 * workspace keeps them only in the End node.
 * @param {any} graph
 * @returns {Record<string, unknown>}
 */
export function endFields(graph) {
  const nested = graph?.nodes?.output?.fields;
  if (nested && typeof nested === 'object' && Object.keys(nested).length) return nested;
  return graph?.output && typeof graph.output === 'object' ? graph.output : {};
}

/**
 * Whether the End node reads steps the graph leaves out, as for a protected workflow read
 * from another workspace.
 * @param {any} graph
 */
export function hasHiddenSteps(graph) {
  const nodes = graph?.nodes && typeof graph.nodes === 'object' ? graph.nodes : {};
  const referenced = new Set();
  for (const reference of Object.values(endFields(graph))) {
    const step = typeof reference === 'string' ? reference.match(/^\$(node-[A-Za-z0-9_-]+)\./) : null;
    if (step) referenced.add(step[1]);
  }
  for (const dependency of Array.isArray(nodes.output?.depends) ? nodes.output.depends : []) {
    if (dependency !== 'input') referenced.add(String(dependency));
  }
  return [...referenced].some((id) => !nodes[id]);
}

/**
 * The fee a run pays the creator of a priced gallery workflow, or of a clone of one.
 * @param {any} workflow Workflow/Detail `workflow[0]`
 */
export function creatorFee(workflow) {
  const amount = (value) => {
    const fee = Number(value);
    return Number.isFinite(fee) && fee > 0 ? fee : 0;
  };
  if (workflow?.clonedfromid !== undefined && workflow?.clonedfromid !== null) return amount(workflow.runchargeamount);
  const listed = Number(workflow?.ispublic) === 1 && Number(workflow?.status) === 2;
  return Number(workflow?.ismonetized) === 1 && listed ? amount(workflow.amount) : 0;
}

/**
 * The estimated cost of one run: the sum of each step's model price for the settings it
 * uses, plus a creator's fee. A workflow whose steps are hidden comes with Wiro AI's own
 * estimate, and each step it can't price there is reported.
 * @param {import('./wiro.js').RunApi} api
 * @param {any} workflow Workflow/Detail `workflow[0]`
 * @param {Record<string, unknown>} values the Start values of the run
 * @param {Logger} log
 * @returns {Promise<import('./pricing.js').Estimate>}
 */
export async function estimateWorkflowCost(api, workflow, values, log) {
  const graph = graphOf(workflow?.contents);
  const nodes = graph?.nodes && typeof graph.nodes === 'object' ? graph.nodes : {};
  const fee = creatorFee(workflow);
  const feeStep = fee
    ? [{ label: "the workflow creator's fee", tool: null, price: { kind: 'priced', value: fee } }]
    : [];

  if (hasHiddenSteps(graph)) {
    const given = workflow?.estimatedcost;
    const value = Number(given?.value);
    if (given?.type !== 'estimated' || !Number.isFinite(value)) {
      return {
        value: null,
        parts: [{ label: 'The hidden steps', price: { kind: 'unknown' }, llm: false }],
        source: 'server',
      };
    }
    const details = Array.isArray(given.details) ? given.details : [];
    const parts = details.map((detail) => ({
      label: 'A hidden step',
      price: {
        kind: /** @type {const} */ ('unknown'),
        reason: String(detail?.code ?? 'unknown'),
        ...(detail?.startfield ? { field: String(detail.startfield) } : {}),
      },
      llm: false,
    }));
    return { value: roundUsd(value + fee), parts, source: 'server' };
  }

  const steps = stepsToRun(nodes).filter((id) => {
    const tool = nodes[id]?.tool;
    return typeof tool === 'string' && tool && !tool.startsWith('workflow-utilities/');
  });
  const tools = new Map();
  const priced = [];
  for (const id of steps) {
    const slug = String(nodes[id].tool);
    const label = `${id} (${slug})`;
    if (!tools.has(slug)) {
      const [owner, project] = slug.split('/');
      try {
        const detail = await api.toolDetail(owner, project);
        tools.set(slug, Array.isArray(detail?.tool) ? (detail.tool[0] ?? null) : null);
      } catch (err) {
        log.debug(`Tool/Detail for ${slug} failed: ${err.message}`);
        tools.set(slug, null);
      }
    }
    const tool = tools.get(slug);
    if (!tool) {
      priced.push({ label, tool: null, price: { kind: 'unknown' } });
      continue;
    }
    /** @type {Record<string, unknown>} */
    const input = {};
    for (const [key, value] of Object.entries(nodes[id].input ?? {})) input[key] = resolveStepValue(value, values);
    priced.push({ label, tool, price: priceStep(tool, runValues(tool, input)) });
  }
  return sumEstimate([...priced, ...feeStep]);
}

/**
 * Starts the run, trying again after concurrency refusals.
 * @param {import('./wiro.js').RunApi} api
 * @param {string} slug
 * @param {Record<string, unknown>} input
 * @param {number} deadline
 * @param {Logger} log
 * @param {number} [firstWaitMs]
 * @returns {Promise<RunHandle>}
 */
export async function submitWorkflowRun(api, slug, input, deadline, log, firstWaitMs) {
  try {
    const data = await withConcurrencyRetry(
      (timeoutMs) => api.workflowRun(slug, input, timeoutMs),
      deadline,
      log,
      firstWaitMs,
    );
    if (!data?.workflowtoken) throw new WiroApiError('Workflow/Run answered without a run token.');
    return { token: String(data.workflowtoken) };
  } catch (err) {
    if (err instanceof WiroApiError && err.code === 97) {
      throw new WiroApiError(`${err.message}. Add funds at https://wiro.ai/panel/billing.`, { code: 97 });
    }
    throw err;
  }
}

/** What happens to a run the action stops waiting for. */
export const RUN_GOES_ON = 'The run keeps going on Wiro AI, and its results appear there when it ends.';

/**
 * Polls Workflow/RunDetail until the run ends, or the deadline passes.
 * @param {import('./wiro.js').RunApi} api
 * @param {RunHandle} handle
 * @param {{ deadline: number, pollMs: number, timeoutMs: number, log: Logger, refusalLimitMs?: number }} options
 */
export async function waitForWorkflowRun(
  api,
  handle,
  { deadline, pollMs, timeoutMs, log, refusalLimitMs = REFUSAL_LIMIT_MS },
) {
  const stepStatus = new Map();
  let failures = 0;
  let refusingSince;
  for (;;) {
    let data;
    try {
      data = await api.workflowRunDetail(handle.token, Math.max(5_000, Math.min(60_000, deadline - Date.now())));
      failures = 0;
      refusingSince = undefined;
    } catch (err) {
      if (err instanceof WiroApiError && (err.status === 401 || err.status === 403)) throw err;
      if (err instanceof WiroApiError && !err.retryable) {
        refusingSince ??= Date.now();
        if (Date.now() - refusingSince >= refusalLimitMs) {
          throw new TaskError(`Stopped waiting for the workflow run: ${err.message} ${RUN_GOES_ON}`);
        }
      } else {
        failures += 1;
      }
      const note = `Workflow/RunDetail failed (${err.message}); trying again.`;
      if (failures === 3) log.warning(note);
      else log.debug(note);
    }

    const run = data?.workflowrun;
    if (run?.status) {
      handle.status = String(run.status);
      handle.nodes = Array.isArray(data.workflowrunnodes) ? data.workflowrunnodes : [];
      for (const node of handle.nodes) {
        if (!node?.nodeId || stepStatus.get(node.nodeId) === node.status) continue;
        stepStatus.set(node.nodeId, node.status);
        log.info(`Step ${oneLine(node.nodeId)}${node.tool ? ` (${oneLine(node.tool)})` : ''}: ${oneLine(node.status)}`);
      }
      if (TERMINAL_RUN_STATUSES.has(handle.status)) return data;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
  }
  throw new TaskError(`The workflow run did not finish within ${Math.round(timeoutMs / 1000)} s. ${RUN_GOES_ON}`);
}

/**
 * Throws unless the run completed.
 * @param {any} data Workflow/RunDetail answer
 */
export function assertRunCompleted(data) {
  const status = String(data?.workflowrun?.status ?? '');
  if (status === 'completed') return;
  const nodes = Array.isArray(data?.workflowrunnodes) ? data.workflowrunnodes : [];
  if (status === 'failed') {
    const failed = nodes
      .filter((node) => node?.status === 'failed')
      .map(
        (node) =>
          `${node.nodeId}${node.tool ? ` (${node.tool})` : ''} failed` +
          (node.cause ? ` (${node.cause})` : '') +
          (node.error ? `: ${String(node.error).trim()}` : ''),
      );
    throw new TaskError(
      `The workflow run failed. ${failed.length ? `${failed.join('; ')}.` : 'No step reported why.'}`,
    );
  }
  if (status === 'cancelled') throw new TaskError('The workflow run was cancelled.');
  throw new TaskError(`The workflow run ended as ${status || 'unknown'}.`);
}

/**
 * @typedef {{ name?: string, contenttype?: string, size?: number | string, url?: string, text?: string }} ResultItem
 */

/**
 * @param {unknown} raw
 * @returns {ResultItem[]}
 */
function resultItems(raw) {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : [raw];
  const items = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      // Only a lone link is a file; text that starts with a link stays text.
      items.push(/^https?:\/\/\S+$/i.test(entry.trim()) ? { url: entry.trim() } : { text: entry.trim() });
    } else if (typeof entry === 'number' || typeof entry === 'boolean') {
      items.push({ text: String(entry) });
    } else if (entry && typeof entry === 'object') {
      if (entry.contenttype === 'raw') {
        items.push({ contenttype: 'raw', text: rawAnswer(entry.content) });
        continue;
      }
      const [item] = normalizeOutputs({ outputs: [entry] });
      if (item && (item.url || item.name)) {
        delete item.content;
        items.push(item);
      }
    }
  }
  return items;
}

/**
 * What the run's End node shows, by result name.
 * @param {any} data Workflow/RunDetail answer
 * @returns {Record<string, ResultItem[]>}
 */
export function workflowResults(data) {
  const run = data?.workflowrun ?? {};
  const graph = graphOf(run.contents);
  const fields = endFields(graph);
  const nodes = new Map(
    (Array.isArray(data?.workflowrunnodes) ? data.workflowrunnodes : []).map((node) => [String(node?.nodeId), node]),
  );
  const saved = graph?.metadata?.input?.values ?? {};
  /** @type {Record<string, ResultItem[]>} */
  const results = {};
  for (const [name, reference] of Object.entries(fields)) {
    if (typeof reference !== 'string') {
      results[name] = [];
      continue;
    }
    const step = reference.match(/^\$(node-[A-Za-z0-9_-]+)\.(.+)$/);
    if (step) {
      const node = nodes.get(step[1]);
      const outputs = node?.outputs;
      const port = step[2];
      results[name] = resultItems(port === 'outputs' ? outputs : outputs?.[port]);
      continue;
    }
    const start = reference.match(/^\$input\.(.+)$/);
    results[name] = resultItems(start ? saved[start[1]] : reference);
  }
  return results;
}

/**
 * Runs a workflow and waits for it: Workflow/Run, then Workflow/RunDetail until it ends.
 * @param {object} options
 * @param {import('./wiro.js').RunApi} options.api
 * @param {string} options.slug
 * @param {Record<string, unknown>} options.input the Start values to send, files as URLs
 * @param {number} options.timeoutMs
 * @param {number} options.pollMs
 * @param {Logger} options.log
 * @param {(handle: RunHandle) => void} [options.onRun]
 * @param {(pending: Promise<RunHandle>) => void} [options.onSubmit]
 * @param {number} [options.refusalLimitMs]
 */
export async function runWorkflow({ api, slug, input, timeoutMs, pollMs, log, onRun, onSubmit, refusalLimitMs }) {
  const deadline = Date.now() + timeoutMs;
  const submitting = submitWorkflowRun(api, slug, input, deadline, log);
  onSubmit?.(submitting);
  const handle = await submitting;
  onRun?.(handle);
  log.info(`Started a run of ${slug}.`);

  const data = await waitForWorkflowRun(api, handle, { deadline, pollMs, timeoutMs, log, refusalLimitMs });
  assertRunCompleted(data);

  const run = data.workflowrun;
  const results = workflowResults(data);
  const items = Object.values(results).flat();
  return {
    handle,
    run,
    nodes: handle.nodes ?? [],
    results,
    urls: items.filter((item) => item.url).map((item) => /** @type {string} */ (item.url)),
    files: items.filter((item) => item.url),
    text: items
      .filter((item) => item.text)
      .map((item) => item.text)
      .join('\n\n'),
    cost: formatCost(run.chargedcost ?? run.totalcost),
    elapsedSeconds: Number(run.elapsedseconds) || undefined,
  };
}
