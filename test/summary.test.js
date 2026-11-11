import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { llmSummary, modelSummary } from '../src/summary.js';

describe('job summary', () => {
  it('shows images inline and links other files', () => {
    const markdown = modelSummary({
      modelId: 'pruna/p-image',
      taskId: '42',
      cost: '0.005',
      elapsedSeconds: 9,
      outputs: [
        { name: 'a.png', contenttype: 'image/png', url: 'https://cdn.example/a.png' },
        { name: 'b.png', contenttype: 'image/png', url: 'https://cdn.example/b.png' },
        { name: 'clip [1].mp4', contenttype: 'video/mp4', url: 'https://cdn.example/clip.mp4' },
      ],
      text: '',
      files: ['out/a.png'],
    });
    assert.equal(
      markdown,
      [
        '### Wiro AI: pruna/p-image',
        '',
        '| Task | Cost (USD) | Time |',
        '| --- | --- | --- |',
        '| 42 | 0.005 | 9 s |',
        '',
        '<img src="https://cdn.example/a.png" alt="a.png" width="480">',
        '<img src="https://cdn.example/b.png" alt="b.png" width="480">',
        '',
        '- [clip 1.mp4](https://cdn.example/clip.mp4)',
        '',
        'Downloaded: `out/a.png`',
        '',
      ].join('\n'),
    );
  });

  it('shows the answer and token counts of an LLM', () => {
    const markdown = llmSummary({
      modelId: 'openai/gpt-5-nano',
      cost: '0.0001923',
      finishReason: 'stop',
      usage: { prompt_tokens: 1646, completion_tokens: 275 },
      text: 'A | pipe\nand a second line',
    });
    assert.match(markdown, /\| 1646 \| 275 \| 0\.0001923 \| stop \|/);
    assert.ok(markdown.endsWith('A | pipe\nand a second line\n'));
  });
});
