import YAML from 'yaml';
import { InputError } from './errors.js';

/** Defaults, kept equal to action.yml by a test. */
export const DEFAULTS = Object.freeze({
  // Empty: `workflow` when the workflow input is set, else `model`.
  mode: '',
  timeout: 600,
  'poll-interval': 3,
  'cancel-on-timeout': true,
  download: false,
  'download-dir': 'wiro-output',
  summary: true,
  'api-url': 'https://api.wiro.ai/v1',
  'llm-url': 'https://llm.wiro.ai/v1',
});

const MODEL_ID = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

/**
 * @param {string} value `owner/project`
 * @param {'model' | 'llm'} mode
 * @returns {{ id: string, owner: string, project: string }}
 */
export function parseModel(value, mode) {
  const id = String(value ?? '').trim();
  if (!MODEL_ID.test(id)) {
    const example = mode === 'llm' ? 'openai/gpt-5-4-mini' : 'pruna/p-image';
    throw new InputError(`\`model\` must be a model ID like \`${example}\`${id ? `, not \`${id}\`` : ''}.`);
  }
  const [owner, project] = id.split('/');
  return { id, owner, project };
}

const MODES = ['model', 'llm', 'workflow'];

/**
 * @param {string} value
 * @param {{ workflow?: string }} [others] other inputs that decide an empty mode
 * @returns {'model' | 'llm' | 'workflow'}
 */
export function parseMode(value, { workflow = '' } = {}) {
  const mode = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!mode) return String(workflow).trim() ? 'workflow' : 'model';
  if (!MODES.includes(mode)) {
    throw new InputError(`\`mode\` must be \`model\`, \`llm\` or \`workflow\`, not \`${value}\`.`);
  }
  return /** @type {'model' | 'llm' | 'workflow'} */ (mode);
}

/**
 * The `max-cost` limit in USD, or undefined when it is not set.
 * @param {string} value
 */
export function parseMaxCost(value) {
  const text = String(value ?? '')
    .trim()
    .replace(/^\$/, '');
  if (!text) return undefined;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new InputError(`\`max-cost\` must be an amount in USD, such as \`0.50\`, not \`${value}\`.`);
  }
  return amount;
}

/**
 * Parses JSON first, then YAML. Empty input gives undefined.
 * @param {string} value
 * @param {string} name
 */
function parseStructured(value, name) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    try {
      return YAML.parse(text);
    } catch (err) {
      const reason = String(err?.message ?? err)
        .split('\n')[0]
        .replace(/:\s*$/, '');
      throw new InputError(`\`${name}\` is not valid JSON or YAML: ${reason}`);
    }
  }
}

/**
 * A mapping of names to values, written as JSON or YAML.
 * @param {string} value
 * @param {string} name
 * @returns {Record<string, unknown>}
 */
export function parseMapping(value, name) {
  const data = parseStructured(value, name);
  if (data === undefined || data === null) return {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new InputError(`\`${name}\` must be a mapping of names to values, in JSON or YAML.`);
  }
  return { ...data };
}

/**
 * A list of paths or glob patterns: one per line, a YAML list, or a JSON array.
 * @param {string} value
 * @param {string} name
 * @returns {string[]}
 */
export function parseList(value, name) {
  const text = String(value ?? '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    const data = parseStructured(text, name);
    if (!Array.isArray(data) || data.some((item) => typeof item !== 'string')) {
      throw new InputError(`\`${name}\` must be a list of paths.`);
    }
    return data.map((item) => item.trim()).filter(Boolean);
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^-\s+/, ''))
    .map((line) => line.replace(/^(['"])(.*)\1$/, '$2'))
    .filter((line) => line && !line.startsWith('#'));
}

/**
 * Model mode `files`: a mapping of parameter ID to one path or a list of paths.
 * @param {string} value
 * @returns {Record<string, string[]>}
 */
export function parseFileMapping(value) {
  const data = parseMapping(value, 'files');
  /** @type {Record<string, string[]>} */
  const result = {};
  for (const [id, entry] of Object.entries(data)) {
    const paths = Array.isArray(entry) ? entry : [entry];
    if (!paths.length || paths.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new InputError(
        `\`files\`: \`${id}\` must be a path or a list of paths, for example \`${id}: images/photo.png\`.`,
      );
    }
    result[id] = paths.map((item) => item.trim());
  }
  return result;
}

/**
 * @param {string} value
 * @param {string} name
 * @param {boolean} fallback
 */
export function parseBoolean(value, name, fallback) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (['true', 'True', 'TRUE'].includes(text)) return true;
  if (['false', 'False', 'FALSE'].includes(text)) return false;
  throw new InputError(`\`${name}\` must be \`true\` or \`false\`, not \`${text}\`.`);
}

/**
 * A positive number of seconds.
 * @param {string} value
 * @param {string} name
 * @param {number} fallback
 * @param {{ min?: number }} [limits]
 */
export function parseSeconds(value, name, fallback, { min = 1 } = {}) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  const seconds = Number(text);
  if (!Number.isFinite(seconds) || seconds < min) {
    throw new InputError(`\`${name}\` must be a number of seconds, at least ${min}. Got \`${text}\`.`);
  }
  return seconds;
}

/**
 * A base URL without its trailing slash.
 * @param {string} value
 * @param {string} name
 * @param {string} fallback
 */
export function parseBaseUrl(value, name, fallback) {
  const text = String(value ?? '').trim() || fallback;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new InputError(`\`${name}\` must be a URL, not \`${text}\`.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new InputError(`\`${name}\` must be an http or https URL.`);
  }
  return text.replace(/\/+$/, '');
}
