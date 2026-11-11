import { runApiHeaders } from './auth.js';
import { WiroApiError } from './errors.js';
import { USER_AGENT } from './version.js';

/**
 * @typedef {object} RunApi
 * @property {(owner: string, project: string, body: object | FormData, timeoutMs?: number) => Promise<any>} run
 * @property {(taskToken: string) => Promise<any>} taskDetail
 * @property {(taskId: string) => Promise<any>} cancel
 * @property {(taskToken: string) => Promise<any>} kill
 * @property {(owner: string, project: string) => Promise<any>} toolDetail
 */

/**
 * A small client for the Wiro AI Run API (https://wiro.ai/docs/run-a-model).
 * Every call is a POST. Success is `result: true`; anything else becomes a WiroApiError.
 * @param {{ apiUrl: string, apiKey: string, apiSecret?: string, fetchImpl?: typeof fetch }} options
 * @returns {RunApi}
 */
export function createRunApi({ apiUrl, apiKey, apiSecret, fetchImpl = fetch }) {
  const base = apiUrl.replace(/\/+$/, '');

  /**
   * @param {string} route
   * @param {object | FormData} body
   * @param {number} [timeoutMs]
   */
  async function post(route, body, timeoutMs = 60_000) {
    /** @type {Record<string, string>} */
    const headers = {
      ...runApiHeaders({ apiKey, apiSecret }),
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    };
    let payload;
    if (body instanceof FormData) {
      payload = body;
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const response = await fetchImpl(`${base}${route}`, {
      method: 'POST',
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new WiroApiError(`${route} answered HTTP ${response.status} without a JSON body.`, {
        status: response.status,
        retryable: response.status >= 500 || response.status === 429,
      });
    }
    if (data?.result !== true) {
      const errors = Array.isArray(data?.errors) ? data.errors : [];
      const message =
        errors
          .map((error) => (typeof error === 'string' ? error : error?.message))
          .filter(Boolean)
          .join('; ') || `${route} answered HTTP ${response.status} with result: false.`;
      const code = errors.find((error) => typeof error?.code === 'number')?.code;
      throw new WiroApiError(message, {
        code,
        status: response.status,
        retryable: response.status >= 500,
      });
    }
    return data;
  }

  return {
    run: (owner, project, body, timeoutMs = 300_000) =>
      post(`/Run/${encodeURIComponent(owner)}/${encodeURIComponent(project)}`, body, timeoutMs),
    taskDetail: (taskToken) => post('/Task/Detail', { tasktoken: taskToken }),
    cancel: (taskId) => post('/Task/Cancel', { taskid: taskId }),
    kill: (taskToken) => post('/Task/Kill', { socketaccesstoken: taskToken }),
    toolDetail: (owner, project) => post('/Tool/Detail', { slugowner: owner, slugproject: project }),
  };
}
