/** A logger that keeps what it was given. */
export function captureLog() {
  const lines = { info: [], warning: [], debug: [] };
  return {
    lines,
    info: (message) => lines.info.push(message),
    warning: (message) => lines.warning.push(message),
    debug: (message) => lines.debug.push(message),
  };
}
