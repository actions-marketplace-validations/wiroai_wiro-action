// Control characters and the Unicode line and paragraph separators.
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const LINE_BREAKS = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]+', 'g');

/**
 * Text from outside the action on one log line. A line break could start a new line with
 * `::`, which the runner reads as a workflow command.
 * @param {unknown} value
 */
export function oneLine(value) {
  return String(value ?? '')
    .replace(LINE_BREAKS, ' ')
    .trim();
}
