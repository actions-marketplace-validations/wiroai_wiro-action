import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bearerToken } from './auth.js';
import { InputError, LlmError } from './errors.js';
import { displayPath } from './files.js';
import { formatCost } from './model.js';
import { USER_AGENT } from './version.js';

/** Protocol request bodies are limited to 16 MiB. */
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Errors the gateway documents as safe to send again: nothing ran and nothing was billed. */
const RETRYABLE_CODES = new Set([
  'provider_overloaded',
  'provider_unavailable',
  'authentication_service_unavailable',
  'gateway_shutting_down',
  'rate_limit_exceeded',
]);

/** Fields the action sets itself. */
const RESERVED_FIELDS = ['model', 'messages', 'stream'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {Buffer} data */
function looksBinary(data) {
  return data.subarray(0, 8000).includes(0);
}

/**
 * The user message: each file as its own part, then the prompt. Text files are inlined
 * in `<file>` tags, images go as image parts and PDFs as file parts, both base64 data URLs.
 * @param {string} prompt
 * @param {string[]} files absolute paths
 * @param {string} workspace
 */
export async function buildUserContent(prompt, files, workspace) {
  if (!files.length) return prompt;
  /** @type {Array<Record<string, unknown>>} */
  const parts = [];
  for (const file of files) {
    const shown = displayPath(file, workspace);
    const ext = path.extname(file).toLowerCase();
    const data = await readFile(file);
    if (IMAGE_TYPES[ext]) {
      parts.push({ type: 'text', text: `Image: ${shown}` });
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${IMAGE_TYPES[ext]};base64,${data.toString('base64')}` },
      });
    } else if (ext === '.pdf') {
      parts.push({ type: 'text', text: `Document: ${shown}` });
      parts.push({
        type: 'file',
        file: {
          filename: path.basename(file),
          file_data: `data:application/pdf;base64,${data.toString('base64')}`,
        },
      });
    } else if (looksBinary(data)) {
      throw new InputError(
        `\`files\`: ${shown} is a binary file. llm mode attaches text files, images (PNG, JPEG, GIF, WebP) and PDF documents.`,
      );
    } else {
      parts.push({ type: 'text', text: `<file path="${shown}">\n${data.toString('utf8')}\n</file>` });
    }
  }
  parts.push({ type: 'text', text: prompt });
  return parts;
}

/**
 * The Chat Completions request body.
 * @param {{ model: string, prompt: string, system?: string, extra?: Record<string, unknown>, files?: string[], workspace: string }} options
 */
export async function buildChatRequest({ model, prompt, system, extra = {}, files = [], workspace }) {
  for (const field of RESERVED_FIELDS) {
    if (field in extra) {
      throw new InputError(
        `\`params\` can't set \`${field}\`: the action sets it from the \`model\`, \`prompt\`, \`system\` and \`files\` inputs.`,
      );
    }
  }
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: await buildUserContent(prompt, files, workspace) });
  return { ...extra, model, messages, stream: false };
}

/** @param {Headers} headers */
function retryAfterMs(headers) {
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/**
 * @param {number} status
 * @param {any} error
 */
function describeError(status, error) {
  const message = typeof error?.message === 'string' && error.message ? error.message : `HTTP ${status}`;
  const code = typeof error?.code === 'string' ? error.code : undefined;
  let text = code ? `${message} (${code})` : message;
  if (status === 401) {
    text += '. Check `api-key`, and `api-secret` for projects that use signature authentication.';
  }
  return new LlmError(`The LLM gateway answered: ${text}`, { status, code, type: error?.type });
}

/**
 * Sends a Chat Completions request to the Wiro AI LLM gateway
 * (https://wiro.ai/docs/completions-api) and returns the answer.
 * @param {object} options
 * @param {string} options.llmUrl
 * @param {string} options.apiKey
 * @param {string} [options.apiSecret]
 * @param {Record<string, unknown>} options.body
 * @param {number} options.timeoutMs
 * @param {import('./model.js').Logger} options.log
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.retryDelayMs]
 */
export async function runChat({
  llmUrl,
  apiKey,
  apiSecret,
  body,
  timeoutMs,
  log,
  fetchImpl = fetch,
  retryDelayMs = 5_000,
}) {
  const payload = JSON.stringify(body);
  const size = Buffer.byteLength(payload);
  if (size > MAX_REQUEST_BYTES) {
    const mib = (size / 1024 / 1024).toFixed(1);
    throw new InputError(
      `The request is ${mib} MiB, and the LLM gateway takes up to 16 MiB per request. Attach fewer or smaller files.`,
    );
  }

  const deadline = Date.now() + timeoutMs;
  const url = `${llmUrl.replace(/\/+$/, '')}/chat/completions`;
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: bearerToken({ apiKey, apiSecret }),
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: payload,
        signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError') {
        throw new LlmError(`No answer from the LLM gateway within ${Math.round(timeoutMs / 1000)} s.`);
      }
      throw new LlmError(`Could not reach the LLM gateway: ${err?.message ?? err}`);
    }

    // A slow answer gets its headers early and newlines every 15 s before the JSON body.
    const text = (await response.text()).trim();
    let data;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }

    const error = data?.error ?? (response.ok && data ? undefined : { message: `HTTP ${response.status}` });
    if (!error) return readCompletion(data, response.headers, String(body.model), log);

    const status = response.status;
    const code = typeof error?.code === 'string' ? error.code : undefined;
    const retryable =
      status === 429 || status === 503 || status === 529 || (code !== undefined && RETRYABLE_CODES.has(code));
    const wait = retryAfterMs(response.headers) ?? retryDelayMs * attempt;
    if (retryable && attempt < 3 && Date.now() + wait < deadline) {
      log.info(`The LLM gateway is busy (${error?.message ?? status}). Trying again in ${Math.ceil(wait / 1000)} s.`);
      await sleep(wait);
      continue;
    }
    throw describeError(status, error);
  }
}

/**
 * @param {any} data
 * @param {Headers} headers
 * @param {string} model
 * @param {import('./model.js').Logger} log
 */
export function readCompletion(data, headers, model, log) {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
  if (!choice) throw new LlmError('The LLM gateway answered without a choice.');

  const message = choice.message ?? {};
  let text = '';
  if (typeof message.content === 'string') {
    text = message.content;
  } else if (Array.isArray(message.content)) {
    text = message.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  }
  text = text.trim();

  const reason = choice.finish_reason;
  if (reason === 'content_filter') {
    throw new LlmError('The model stopped because of its content filter (finish_reason: content_filter).');
  }
  if (reason === 'length') {
    log.warning(
      'The answer reached the token limit and may be cut short. Raise `max_tokens` in `params` for a longer one.',
    );
  }
  if (!text && Array.isArray(message.tool_calls) && message.tool_calls.length) {
    log.warning('The model answered with tool calls and no text. Read them from the `response` output.');
  } else if (!text) {
    log.warning('The model returned an empty answer.');
  }

  const dropped = headers.get('x-wiro-dropped-parameters');
  if (dropped) log.warning(`The gateway left out fields that ${model} does not use: ${dropped}`);
  const adjusted = headers.get('x-wiro-adjusted-parameters');
  if (adjusted) log.info(`The gateway adjusted: ${adjusted}`);

  return {
    text,
    finishReason: typeof reason === 'string' ? reason : '',
    cost: formatCost(data?.usage?.cost),
    usage: data?.usage,
    id: typeof data?.id === 'string' ? data.id : '',
    response: data,
  };
}
