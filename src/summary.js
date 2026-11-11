const MAX_TEXT = 30_000;

/** @param {unknown} value */
function cell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

/** @param {string} text */
function truncated(text) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n…` : text;
}

/** @param {string} value */
function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Markdown for a model run.
 * @param {{ modelId: string, taskId: string, cost: string, elapsedSeconds?: number, outputs: Array<{ name?: string, contenttype?: string, url?: string }>, text: string, files: string[] }} result
 */
export function modelSummary({ modelId, taskId, cost, elapsedSeconds, outputs, text, files }) {
  const lines = [
    `### Wiro AI: ${modelId}`,
    '',
    '| Task | Cost (USD) | Time |',
    '| --- | --- | --- |',
    `| ${cell(taskId)} | ${cell(cost || '0')} | ${elapsedSeconds ? `${elapsedSeconds} s` : ''} |`,
    '',
  ];
  const withUrl = outputs.filter((output) => output.url);
  const isImage = (output) => String(output.contenttype ?? '').startsWith('image/');
  const images = withUrl
    .filter(isImage)
    .map(
      (output) =>
        `<img src="${escapeHtml(output.url ?? '')}" alt="${escapeHtml(output.name || 'output')}" width="480">`,
    );
  const links = withUrl
    .filter((output) => !isImage(output))
    .map((output) => `- [${cell(output.name || 'output').replace(/[[\]]/g, '')}](${output.url})`);
  if (images.length) lines.push(images.join('\n'), '');
  if (links.length) lines.push(...links, '');
  if (files.length) {
    lines.push(`Downloaded: ${files.map((file) => `\`${file}\``).join(', ')}`, '');
  }
  if (text) lines.push(truncated(text), '');
  return lines.join('\n');
}

/**
 * Markdown for an LLM answer.
 * @param {{ modelId: string, cost: string, finishReason: string, usage?: any, text: string }} result
 */
export function llmSummary({ modelId, cost, finishReason, usage, text }) {
  const tokensIn = usage?.prompt_tokens ?? '';
  const tokensOut = usage?.completion_tokens ?? '';
  return [
    `### Wiro AI: ${modelId}`,
    '',
    '| Input tokens | Output tokens | Cost (USD) | Finish reason |',
    '| --- | --- | --- | --- |',
    `| ${cell(tokensIn)} | ${cell(tokensOut)} | ${cell(cost || '0')} | ${cell(finishReason)} |`,
    '',
    truncated(text),
    '',
  ].join('\n');
}
