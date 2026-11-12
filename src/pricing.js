// Price estimates made before a run. A model's price comes from its price list
// (`dynamicprice` in Tool/Detail), matched against the values the run sends, the way the
// model page on wiro.ai shows it. See https://wiro.ai/docs/pricing
import { inflateSync } from 'node:zlib';
import { CostError } from './errors.js';

const BILLED_METHODS = new Set([
  'cps',
  'cpr',
  'cp-promptlength',
  'cp-audiosecondslength',
  'cpo',
  'cpt',
  'cp-pixel',
  'cp-realtimeturn',
  'cp-readoutput',
  'cp-outputVideoLength',
]);

const FILE_TYPES = new Set(['fileinput', 'multifileinput', 'multifileinputdrop', 'combinefileinput']);

/** Rough token sizes for llm mode estimates. */
export const TOKENS_PER_IMAGE = 1_600;
export const TOKENS_PER_PDF_PAGE = 1_600;
export const CHARS_PER_TOKEN = 3;

/**
 * @typedef {object} StepPrice
 * @property {'priced' | 'per-unit' | 'metered' | 'unknown'} kind
 * @property {number} [value] USD, for `priced`
 * @property {number} [rate] USD per unit, for `per-unit`
 * @property {string} [unit] what `rate` is charged for
 * @property {string} [method] the price list's billing method
 * @property {string} [basis] `listed` or `average` when the amount is an estimate of its own
 * @property {string} [note] the price list's note
 */

/** @param {unknown} value */
const toNumber = (value) => {
  const number = parseFloat(String(value));
  return Number.isFinite(number) ? number : 0;
};

/** @param {unknown} value */
const isNumeric = (value) => value !== '' && value !== null && Number.isFinite(Number(value));

/** @param {unknown} value */
export function parsePriceRows(value) {
  let rows = value;
  if (typeof rows === 'string') {
    try {
      rows = JSON.parse(rows);
    } catch {
      return [];
    }
  }
  return Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
}

/**
 * Whether a model is an LLM, from its categories.
 * @param {any} tool
 */
export function isLlmTool(tool) {
  const categories = Array.isArray(tool?.categories) ? tool.categories : [];
  return categories.some((category) => /(^|-)llm(-|$)/.test(String(category)));
}

/**
 * The value a parameter starts with. A checkbox starts at its `value`; its `defaultvalue`
 * is the value it sends when switched on.
 * @param {any} item a Tool/Detail parameter
 */
export function startingValue(item) {
  if (String(item?.type ?? '').toLowerCase() === 'checkbox' && Object.prototype.hasOwnProperty.call(item, 'value')) {
    return item.value;
  }
  return item?.defaultvalue;
}

/**
 * The values a run sends: the caller's parameters over the model's defaults. As in the Run
 * API, file parameters, parameters whose id contains `input` and an optional `prompt` get
 * no default.
 * @param {any} tool Tool/Detail `tool[0]`
 * @param {Record<string, unknown>} params
 */
export function runValues(tool, params) {
  /** @type {Record<string, unknown>} */
  const values = {};
  for (const group of Array.isArray(tool?.parameters) ? tool.parameters : []) {
    for (const item of Array.isArray(group?.items) ? group.items : []) {
      if (!item?.id) continue;
      const id = String(item.id);
      if (FILE_TYPES.has(item.type) || id.includes('input') || (id === 'prompt' && item.required !== true)) continue;
      const fallback = startingValue(item);
      if (fallback !== undefined && fallback !== null && fallback !== '') values[id] = fallback;
    }
  }
  return { ...values, ...params };
}

/** @param {unknown} value */
function isQuantity(value) {
  return typeof value === 'string' && value.includes('QUANTITY:');
}

/** @param {unknown} value */
function countItems(value) {
  if (Array.isArray(value)) return value.length;
  return value ? 1 : 0;
}

/**
 * @param {unknown} expected a price row value
 * @param {unknown} actual the run's value
 */
function sameValue(expected, actual) {
  if (actual === undefined || actual === null || actual === '') return false;
  if (String(expected) === String(actual)) return true;
  return isNumeric(expected) && isNumeric(actual) && Number(expected) === Number(actual);
}

/**
 * The amount one matched price row gives.
 * @param {any} row
 * @param {any} tool
 * @param {Record<string, unknown>} selected
 * @param {(amount: number) => number} discounted
 * @returns {StepPrice}
 */
function rowPrice(row, tool, selected, discounted) {
  const method = typeof row.priceMethod === 'string' ? row.priceMethod : '';
  const price = toNumber(row.price);
  const note = typeof row.note === 'string' && row.note.trim() ? row.note.trim() : undefined;
  const priced = (amount, basis) => ({
    kind: 'priced',
    value: discounted(amount),
    method,
    ...(basis ? { basis } : {}),
  });
  const perUnit = (unit) => ({ kind: 'per-unit', rate: discounted(price), unit, method, ...(note ? { note } : {}) });
  const average = toNumber(tool?.approximatelycost);

  if (!BILLED_METHODS.has(method)) return { kind: 'unknown', method };
  switch (method) {
    case 'cpr':
    case 'cp-pixel':
      return priced(price);
    case 'cpo': {
      // Charged per output file: `samples` sets how many a run makes.
      const outputs = Math.max(1, Math.floor(toNumber(selected.samples)) || 1);
      return priced(price * outputs);
    }
    case 'cp-promptlength': {
      const prompt = selected.prompt;
      return typeof prompt === 'string' && prompt ? priced(price * prompt.length) : perUnit('character of the prompt');
    }
    case 'cp-outputVideoLength': {
      const seconds = toNumber(selected.duration);
      return seconds > 0 ? priced(price * seconds) : perUnit('second of video');
    }
    case 'cp-readoutput':
    case 'cp-realtimeturn':
      // The run reports its cost when it ends; a price above 0 is a listed estimate.
      return price > 0 ? priced(price, 'listed') : { kind: 'metered', method, ...(note ? { note } : {}) };
    case 'cps':
      return average > 0 ? priced(average, 'average') : perUnit('second of run time');
    case 'cpt':
      return perUnit('token');
    case 'cp-audiosecondslength':
      return perUnit('second of input audio');
    default:
      return { kind: 'unknown', method };
  }
}

/**
 * The price of one run, from the model's price list and the values the run sends. The first
 * row whose values all match wins; rows that count files (`QUANTITY:n`) take the highest
 * count at or below the number of files sent.
 * @param {any} tool Tool/Detail `tool[0]`
 * @param {Record<string, unknown>} values from runValues, with files as arrays
 * @returns {StepPrice}
 */
export function priceStep(tool, values) {
  const discount = toNumber(tool?.discount);
  // Rounded to drop floating point noise such as 0.15000000000000002.
  const discounted = (amount) => roundUsd(discount > 0 ? amount * (1 - discount / 100) : amount);
  const rows = parsePriceRows(tool?.dynamicprice);

  if (!rows.length) {
    const average = toNumber(tool?.approximatelycost);
    if (average > 0) return { kind: 'priced', value: discounted(average), basis: 'average' };
    const perSecond = toNumber(tool?.cps) || toNumber(tool?.quegroupcps);
    if (perSecond > 0)
      return { kind: 'per-unit', rate: discounted(perSecond), unit: 'second of run time', method: 'cps' };
    return { kind: 'unknown' };
  }

  /** @type {Record<string, unknown>} */
  const selected = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') selected[key] = value;
  }

  let best;
  for (const [index, row] of rows.entries()) {
    const inputs = row.inputs && typeof row.inputs === 'object' ? row.inputs : {};
    const entries = Object.entries(inputs);
    const counted = entries.filter(([, expected]) => isQuantity(expected));
    if (!counted.length) {
      if (entries.every(([key, expected]) => sameValue(expected, selected[key]))) {
        return rowPrice(row, tool, selected, discounted);
      }
      continue;
    }
    const plainMatch = entries
      .filter(([, expected]) => !isQuantity(expected))
      .every(([key, expected]) => sameValue(expected, selected[key]));
    if (!plainMatch) continue;
    for (const [key, expected] of counted) {
      const wanted = parseInt(String(expected).split('QUANTITY:')[1], 10);
      const sent = countItems(selected[key]);
      if (wanted === sent) return rowPrice(row, tool, selected, discounted);
      if (wanted <= sent && (!best || wanted > best.wanted)) best = { wanted, index };
    }
  }
  if (best) return rowPrice(rows[best.index], tool, selected, discounted);
  return { kind: 'unknown' };
}

/**
 * The price of a model run with local files: each file counts as one item of its parameter.
 * @param {any} tool
 * @param {Record<string, unknown>} params
 * @param {Record<string, string[]>} [files]
 */
export function priceModelRun(tool, params, files = {}) {
  const values = runValues(tool, params);
  for (const [id, paths] of Object.entries(files)) {
    const urls = params[id] === undefined ? [] : Array.isArray(params[id]) ? params[id] : [params[id]];
    values[id] = [...urls, ...paths];
  }
  return priceStep(tool, values);
}

/**
 * @typedef {object} EstimatePart
 * @property {string} label the model, or the step and its model
 * @property {StepPrice} price
 * @property {boolean} llm
 */

/**
 * @typedef {object} Estimate
 * @property {number | null} value the estimated USD amount, or null when nothing is known
 * @property {EstimatePart[]} parts every step whose price is not one known amount
 * @property {string} [source] `server` when Wiro AI gave the estimate
 */

/**
 * @param {Array<{ label: string, tool: any, price: StepPrice }>} steps
 * @returns {Estimate}
 */
export function sumEstimate(steps) {
  let total = 0;
  let known = 0;
  const parts = [];
  for (const { label, tool, price } of steps) {
    if (price.kind === 'priced') {
      total += price.value ?? 0;
      known += 1;
      if (price.basis) parts.push({ label, price, llm: isLlmTool(tool) });
    } else {
      parts.push({ label, price, llm: isLlmTool(tool) });
    }
  }
  return { value: known || !steps.length ? roundUsd(total) : null, parts };
}

/** The estimate's parts that keep `max-cost` from being checked: prices not known before the run. */
export function unboundedParts(estimate) {
  return estimate.parts.filter((part) => {
    const { kind, basis } = part.price;
    // LLM token use is billed when the run ends and is reported instead.
    if (part.llm && kind !== 'unknown') return false;
    // An average of past runs or a listed estimate is not a limit the run keeps to.
    return kind !== 'priced' || basis === 'average' || basis === 'listed';
  });
}

/** What a hidden step's price depends on, from the codes of Wiro AI's own estimate. */
const HIDDEN_REASONS = {
  metered: 'its price is set when it ends',
  'no-price': 'it has no price for its settings',
  'start-field': 'its price depends on an input',
  'choose-setting': 'its price depends on a setting',
  'per-unit': 'it is priced per unit of use',
  'earlier-step': 'its price depends on an earlier step',
};

/** @param {EstimatePart} part */
export function describePart(part) {
  const { price } = part;
  if (price.kind === 'priced' && price.basis === 'listed')
    return `${part.label}: listed estimate, the run sets the final price`;
  if (price.kind === 'priced' && price.basis === 'average') return `${part.label}: average of past runs`;
  if (price.kind === 'per-unit') return `${part.label}: $${formatUsd(price.rate ?? 0)} per ${price.unit}`;
  if (price.kind === 'metered') {
    return part.llm
      ? `${part.label}: billed by tokens when the run ends`
      : `${part.label}: the run sets its price when it ends${price.note ? ` (${price.note})` : ''}`;
  }
  if (price.reason) {
    const field = price.field ? ` \`${price.field}\`` : '';
    const reason = HIDDEN_REASONS[price.reason] ?? `its price is not known before the run (${price.reason})`;
    return `${part.label}: ${price.reason === 'start-field' && field ? `its price depends on the input${field}` : reason}`;
  }
  return `${part.label}: no price for these settings`;
}

/** @param {number} amount */
export function roundUsd(amount) {
  return Math.round(amount * 1e10) / 1e10;
}

/**
 * A USD amount for messages, without trailing zeros: 4 decimals from a cent, more below.
 * @param {number} amount
 */
export function formatUsd(amount) {
  if (!Number.isFinite(amount) || amount === 0) return '0';
  const decimals = amount >= 0.01 ? 4 : amount >= 0.0001 ? 6 : 10;
  return amount.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Throws a CostError unless the estimate fits `max-cost`.
 * @param {Estimate} estimate
 * @param {number | undefined} maxCost
 * @param {string} what "The run" or "The workflow run"
 */
export function enforceMaxCost(estimate, maxCost, what) {
  if (maxCost === undefined) return;
  const unbounded = unboundedParts(estimate);
  if (unbounded.length) {
    throw new CostError(
      `${what} was not started: its price can't be confirmed under max-cost $${formatUsd(maxCost)} before it runs. ` +
        `${unbounded.map(describePart).join('; ')}. Remove max-cost to run it anyway.`,
    );
  }
  // What is left unpriced is LLM token use, which the caller reports as not included.
  const value = estimate.value ?? 0;
  if (value > maxCost) {
    throw new CostError(
      `${what} was not started: the estimated cost is $${formatUsd(value)}, above max-cost $${formatUsd(maxCost)}.`,
    );
  }
}

/**
 * Counts the pages of a PDF from its page objects.
 * @param {Buffer} data
 */
export function countPdfPages(data) {
  const text = data.toString('latin1');
  const chunks = [text];
  // PDF 1.5 and later can keep page objects in compressed object streams.
  const streamStart = /\/Type\s*\/ObjStm[^]*?>>\s*stream\r?\n/g;
  for (const match of text.matchAll(streamStart)) {
    if (!/\/FlateDecode/.test(match[0])) continue;
    const start = (match.index ?? 0) + match[0].length;
    const end = text.indexOf('endstream', start);
    if (end === -1) continue;
    try {
      chunks.push(inflateSync(data.subarray(start, end)).toString('latin1'));
    } catch {
      // Not a stream this can read; the page objects outside it still count.
    }
  }
  let pages = 0;
  let declared = 0;
  for (const chunk of chunks) {
    pages += (chunk.match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
    for (const tree of chunk.matchAll(/\/Type\s*\/Pages\b[^]*?\/Count\s+(\d+)/g)) {
      declared = Math.max(declared, Number(tree[1]));
    }
  }
  return Math.max(1, pages, declared);
}

/**
 * The per-token rates for an input of this size: the matching band of a tiered price, or
 * the model's flat rates.
 * @param {any} model GET /v1/models/{owner}/{model}
 * @param {number} inputTokens
 */
export function tokenRates(model, inputTokens) {
  const tiers = Array.isArray(model?.x_wiro?.pricing_tiers) ? model.x_wiro.pricing_tiers : [];
  const fits = (tier) =>
    (tier.maxInputTokens === undefined || inputTokens <= Number(tier.maxInputTokens)) &&
    (tier.minInputTokensExclusive === undefined || inputTokens > Number(tier.minInputTokensExclusive));
  const tier = tiers.find((entry) => entry && typeof entry === 'object' && fits(entry));
  if (tier) return { prompt: toNumber(tier.prompt), completion: toNumber(tier.completion) };
  if (tiers.length) {
    return {
      prompt: Math.max(...tiers.map((entry) => toNumber(entry?.prompt))),
      completion: Math.max(...tiers.map((entry) => toNumber(entry?.completion))),
    };
  }
  return { prompt: toNumber(model?.pricing?.prompt), completion: toNumber(model?.pricing?.completion) };
}

/**
 * An upper estimate of one Chat Completions request: the input from the size of the
 * messages, and the output from `max_tokens` (or the model's limit).
 * @param {{ body: any, model: any }} options `model` is GET /v1/models/{owner}/{model}
 * @returns {Estimate & { inputTokens?: number, outputTokens?: number }}
 */
export function estimateChat({ body, model }) {
  const label = String(body?.model ?? model?.id ?? 'the model');
  const flat = tokenRates(model, 0);
  if (!model?.pricing || (flat.prompt <= 0 && flat.completion <= 0)) {
    return { value: null, parts: [{ label, price: { kind: 'metered' }, llm: false }] };
  }

  let characters = 0;
  let images = 0;
  let pages = 0;
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    const content = message?.content;
    if (typeof content === 'string') {
      characters += content.length;
      continue;
    }
    for (const part of Array.isArray(content) ? content : []) {
      if (part?.type === 'text') characters += String(part.text ?? '').length;
      else if (part?.type === 'image_url') images += 1;
      else if (part?.type === 'file') {
        const data = String(part.file?.file_data ?? '').split(',')[1] ?? '';
        pages += countPdfPages(Buffer.from(data, 'base64'));
      }
    }
  }
  const inputTokens = Math.ceil(characters / CHARS_PER_TOKEN) + images * TOKENS_PER_IMAGE + pages * TOKENS_PER_PDF_PAGE;
  const limit =
    toNumber(body?.max_completion_tokens) ||
    toNumber(body?.max_tokens) ||
    toNumber(model?.top_provider?.max_completion_tokens) ||
    toNumber(model?.max_tokens);
  const rates = tokenRates(model, inputTokens);
  if (!limit) {
    return {
      value: null,
      parts: [{ label, price: { kind: 'per-unit', rate: rates.completion, unit: 'output token' }, llm: false }],
    };
  }
  return {
    value: roundUsd(inputTokens * rates.prompt + limit * rates.completion),
    parts: [],
    inputTokens,
    outputTokens: limit,
  };
}
