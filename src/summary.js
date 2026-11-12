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
    ...fileLines(outputs),
  ];
  if (files.length) {
    lines.push(`Downloaded: ${files.map((file) => `\`${file}\``).join(', ')}`, '');
  }
  if (text) lines.push(truncated(text), '');
  return lines.join('\n');
}

/**
 * Images inline and other files as links, each block followed by a blank line.
 * @param {Array<{ name?: string, contenttype?: string, url?: string }>} outputs
 */
function fileLines(outputs) {
  const withUrl = outputs.filter((output) => output.url);
  const isImage = (output) =>
    String(output.contenttype ?? '').startsWith('image/') ||
    (!output.contenttype && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(output.url ?? ''));
  const images = withUrl
    .filter(isImage)
    .map(
      (output) =>
        `<img src="${escapeHtml(output.url ?? '')}" alt="${escapeHtml(output.name || 'output')}" width="480">`,
    );
  const links = withUrl
    .filter((output) => !isImage(output))
    .map((output) => `- [${cell(output.name || output.url || 'output').replace(/[[\]]/g, '')}](${output.url})`);
  const lines = [];
  if (images.length) lines.push(images.join('\n'), '');
  if (links.length) lines.push(...links, '');
  return lines;
}

/**
 * Markdown for a workflow run: the steps, then each result the End node shows.
 * @param {{ slug: string, title?: string, cost: string, elapsedSeconds?: number, nodes: any[], results: Record<string, Array<{ name?: string, contenttype?: string, url?: string, text?: string }>>, files: string[] }} result
 */
export function workflowSummary({ slug, title, cost, elapsedSeconds, nodes, results, files }) {
  const lines = [
    `### Wiro AI workflow: ${cell(title || slug)}`,
    '',
    '| Workflow | Cost (USD) | Time |',
    '| --- | --- | --- |',
    `| ${cell(slug)} | ${cell(cost || '0')} | ${elapsedSeconds ? `${elapsedSeconds} s` : ''} |`,
    '',
  ];
  if (nodes.length) {
    lines.push('| Step | Model | Status | Time |', '| --- | --- | --- | --- |');
    for (const node of nodes) {
      lines.push(
        `| ${cell(node.nodeId)} | ${cell(node.tool)} | ${cell(node.status)} | ${node.elapsedseconds ? `${cell(node.elapsedseconds)} s` : ''} |`,
      );
    }
    lines.push('');
  }
  for (const [name, items] of Object.entries(results)) {
    lines.push(`**${cell(name)}**`, '', ...fileLines(items));
    const text = items
      .filter((item) => item.text)
      .map((item) => item.text)
      .join('\n\n');
    if (text) lines.push(truncated(text), '');
  }
  if (files.length) {
    lines.push(`Downloaded: ${files.map((file) => `\`${file}\``).join(', ')}`, '');
  }
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
