/** A problem with the action's inputs, found before anything is sent. */
export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

/** An error answer from the Wiro AI Run API (`result: false`, or a body that is not JSON). */
export class WiroApiError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: number, status?: number, retryable?: boolean }} [details]
   */
  constructor(message, { code, status, retryable = false } = {}) {
    super(message);
    this.name = 'WiroApiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/** A failed task: it ended with a non-zero `pexit`, was cancelled, or ran out of time. */
export class TaskError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TaskError';
  }
}

/** An error answer from the LLM gateway. */
export class LlmError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, type?: string }} [details]
   */
  constructor(message, { status, code, type } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.code = code;
    this.type = type;
  }
}
