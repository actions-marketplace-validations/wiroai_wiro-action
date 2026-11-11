import { createHmac } from 'node:crypto';

let lastNonce = 0;

/**
 * A nonce for signature authentication: the current time in milliseconds,
 * never repeated within one run of the action.
 * @param {number} [now]
 */
export function nextNonce(now = Date.now()) {
  lastNonce = Math.max(now, lastNonce + 1);
  return String(lastNonce);
}

/**
 * SIGNATURE = HMAC-SHA256(key = API_KEY, message = API_SECRET + NONCE), hex encoded.
 * See https://wiro.ai/docs/authentication
 * @param {string} apiKey
 * @param {string} apiSecret
 * @param {string} nonce
 */
export function sign(apiKey, apiSecret, nonce) {
  return createHmac('sha256', apiKey)
    .update(apiSecret + nonce)
    .digest('hex');
}

/**
 * Headers for one Run API request. Signature projects get a fresh nonce and signature
 * on every call; API key only projects send just `x-api-key`.
 * @param {{ apiKey: string, apiSecret?: string }} credentials
 * @returns {Record<string, string>}
 */
export function runApiHeaders({ apiKey, apiSecret }) {
  const headers = { 'x-api-key': apiKey };
  if (apiSecret) {
    const nonce = nextNonce();
    headers['x-nonce'] = nonce;
    headers['x-signature'] = sign(apiKey, apiSecret, nonce);
  }
  return headers;
}

/**
 * The LLM gateway's Bearer credential: `API_KEY`, or `API_KEY:API_SECRET` for
 * signature projects. See https://wiro.ai/docs/completions-api
 * @param {{ apiKey: string, apiSecret?: string }} credentials
 */
export function bearerToken({ apiKey, apiSecret }) {
  return `Bearer ${apiSecret ? `${apiKey}:${apiSecret}` : apiKey}`;
}
