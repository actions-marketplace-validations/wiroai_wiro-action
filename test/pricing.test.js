import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CostError } from '../src/errors.js';
import { deflateSync } from 'node:zlib';
import {
  countPdfPages,
  describePart,
  enforceMaxCost,
  estimateChat,
  formatUsd,
  isLlmTool,
  priceModelRun,
  priceStep,
  runValues,
  startingValue,
  sumEstimate,
  tokenRates,
  unboundedParts,
} from '../src/pricing.js';

const select = (id, defaultvalue, values) => ({
  id,
  type: 'select',
  defaultvalue,
  options: values.map((value) => ({ value })),
});

// Shaped like Tool/Detail answers.
const video = {
  categories: ['text-to-video'],
  parameters: [
    {
      items: [
        { id: 'inputImage', type: 'combinefileinput', defaultvalue: 'https://example.com/sample.png' },
        { id: 'prompt', type: 'textarea', required: true, defaultvalue: 'A sample prompt' },
        select('duration', '5', ['5', '10']),
        select('resolution', '720p', ['720p', '1080p']),
        select('draft', 'false', ['true', 'false']),
      ],
    },
  ],
  dynamicprice: JSON.stringify([
    { inputs: { resolution: '720p', draft: 'false', duration: '5' }, price: 0.125, priceMethod: 'cpr' },
    { inputs: { resolution: '720p', draft: 'false', duration: '10' }, price: 0.25, priceMethod: 'cpr' },
    { inputs: { resolution: '1080p', draft: 'false', duration: '5' }, price: 0.3, priceMethod: 'cpr' },
  ]),
};

const tool = (dynamicprice, extra = {}) => ({ parameters: [], dynamicprice, ...extra });

describe('runValues', () => {
  it('fills in defaults the way the Run API does', () => {
    assert.deepEqual(runValues(video, {}), {
      prompt: 'A sample prompt',
      duration: '5',
      resolution: '720p',
      draft: 'false',
    });
    const optionalPrompt = { parameters: [{ items: [{ id: 'prompt', type: 'textarea', defaultvalue: 'showcase' }] }] };
    assert.deepEqual(runValues(optionalPrompt, {}), {}, 'an optional prompt gets no default');
    assert.deepEqual(runValues(video, { duration: 10 }).duration, 10);
  });

  it('starts a checkbox at its value, not at the value it sends when on', () => {
    assert.equal(startingValue({ type: 'checkbox', defaultvalue: '--enhance', value: '' }), '');
    assert.equal(startingValue({ type: 'checkbox', defaultvalue: 'true' }), 'true');
    assert.equal(startingValue({ type: 'select', defaultvalue: '5', value: '10' }), '5');
  });
});

describe('priceStep', () => {
  it('takes the row that matches the settings, defaults included', () => {
    assert.deepEqual(priceModelRun(video, {}), { kind: 'priced', value: 0.125, method: 'cpr' });
    assert.equal(priceModelRun(video, { duration: 10 }).value, 0.25, 'a number matches "10"');
    assert.equal(priceModelRun(video, { resolution: '1080p' }).value, 0.3);
    assert.deepEqual(priceModelRun(video, { duration: '10', resolution: '1080p' }), { kind: 'unknown' });
  });

  it('counts files for QUANTITY rows', () => {
    const rows = [
      { inputs: { inputImage: 'QUANTITY:0' }, price: 0.01, priceMethod: 'cpr' },
      { inputs: { inputImage: 'QUANTITY:1' }, price: 0.02, priceMethod: 'cpr' },
      { inputs: { inputImage: 'QUANTITY:3' }, price: 0.05, priceMethod: 'cpr' },
    ];
    const model = tool(rows);
    assert.equal(priceModelRun(model, {}).value, 0.01);
    assert.equal(priceModelRun(model, {}, { inputImage: ['a.png'] }).value, 0.02);
    assert.equal(priceModelRun(model, {}, { inputImage: ['a.png', 'b.png'] }).value, 0.02, 'highest count at or below');
    assert.equal(
      priceModelRun(model, { inputImage: 'https://x/a.png' }, { inputImage: ['b.png', 'c.png'] }).value,
      0.05,
    );
  });

  it('prices by prompt length, outputs and video seconds', () => {
    const perCharacter = tool([{ inputs: {}, price: 0.00004, priceMethod: 'cp-promptlength' }]);
    assert.equal(priceModelRun(perCharacter, { prompt: 'x'.repeat(500) }).value.toFixed(3), '0.020');
    assert.deepEqual(priceModelRun(perCharacter, {}), {
      kind: 'per-unit',
      rate: 0.00004,
      unit: 'character of the prompt',
      method: 'cp-promptlength',
    });
    const perOutput = tool([{ inputs: {}, price: 0.03, priceMethod: 'cpo' }]);
    assert.equal(priceModelRun(perOutput, { samples: 3 }).value.toFixed(2), '0.09');
    const perSecond = tool([{ inputs: {}, price: 0.06, priceMethod: 'cp-outputVideoLength' }]);
    assert.equal(priceModelRun(perSecond, { duration: '5' }).value.toFixed(2), '0.30');
    assert.equal(priceModelRun(perSecond, {}).kind, 'per-unit');
  });

  it('knows prices that are set when the run ends', () => {
    assert.deepEqual(
      priceStep(tool([{ inputs: {}, price: 0, priceMethod: 'cp-readoutput', note: '$0.05 per 1M tokens' }]), {}),
      {
        kind: 'metered',
        method: 'cp-readoutput',
        note: '$0.05 per 1M tokens',
      },
    );
    assert.deepEqual(priceStep(tool([{ inputs: {}, price: 0.4, priceMethod: 'cp-readoutput' }]), {}), {
      kind: 'priced',
      value: 0.4,
      method: 'cp-readoutput',
      basis: 'listed',
    });
    assert.equal(priceStep(tool([{ inputs: {}, price: 0.00001, priceMethod: 'cpt' }]), {}).kind, 'per-unit');
  });

  it('falls back to the average of past runs, then the rate per second', () => {
    assert.deepEqual(priceStep(tool(null, { approximatelycost: '0.012' }), {}), {
      kind: 'priced',
      value: 0.012,
      basis: 'average',
    });
    assert.deepEqual(priceStep(tool([], { cps: '0.001' }), {}), {
      kind: 'per-unit',
      rate: 0.001,
      unit: 'second of run time',
      method: 'cps',
    });
    assert.deepEqual(priceStep(tool(null), {}), { kind: 'unknown' });
  });

  it('takes off the discount', () => {
    assert.equal(priceStep(tool([{ inputs: {}, price: 0.2, priceMethod: 'cpr' }], { discount: '25' }), {}).value, 0.15);
  });
});

describe('estimates and max-cost', () => {
  const priced = (value, extra = {}) => ({ kind: 'priced', value, ...extra });
  const llm = { categories: ['partner-llm', 'llm-tool-call'] };

  it('tells LLMs from other models', () => {
    assert.equal(isLlmTool(llm), true);
    assert.equal(isLlmTool({ categories: ['text-to-video'] }), false);
  });

  it('sums the known prices and lists the rest', () => {
    const estimate = sumEstimate([
      { label: 'a', tool: {}, price: priced(0.1) },
      { label: 'b', tool: llm, price: { kind: 'metered' } },
      { label: 'c', tool: {}, price: priced(0.2, { basis: 'listed' }) },
    ]);
    assert.equal(estimate.value.toFixed(2), '0.30');
    assert.deepEqual(
      estimate.parts.map((part) => part.label),
      ['b', 'c'],
    );
    assert.deepEqual(
      unboundedParts(estimate).map((part) => part.label),
      ['c'],
      'LLM token use does not block max-cost, a listed estimate does',
    );
  });

  it('does not take an average or a listed estimate as a limit', () => {
    const average = sumEstimate([{ label: 'gpu', tool: {}, price: priced(0.01, { basis: 'average' }) }]);
    assert.throws(() => enforceMaxCost(average, 1, 'The run'), /gpu: average of past runs\. Remove max-cost/);
    const llmListed = sumEstimate([{ label: 'chat', tool: llm, price: priced(0.01, { basis: 'listed' }) }]);
    assert.doesNotThrow(() => enforceMaxCost(llmListed, 1, 'The run'));
  });

  it('describes the hidden steps of a workflow', () => {
    const part = (reason, field) => ({
      label: 'A hidden step',
      price: { kind: 'unknown', reason, ...(field ? { field } : {}) },
      llm: false,
    });
    assert.equal(describePart(part('metered')), 'A hidden step: its price is set when it ends');
    assert.equal(
      describePart(part('start-field', 'duration')),
      'A hidden step: its price depends on the input `duration`',
    );
    assert.equal(describePart(part('mystery')), 'A hidden step: its price is not known before the run (mystery)');
  });

  it('refuses a run above max-cost, or one it cannot price', () => {
    const fits = sumEstimate([{ label: 'a', tool: {}, price: priced(0.125) }]);
    assert.doesNotThrow(() => enforceMaxCost(fits, 0.125, 'The run'));
    assert.doesNotThrow(() => enforceMaxCost(fits, undefined, 'The run'));
    assert.throws(
      () => enforceMaxCost(fits, 0.1, 'The run'),
      (err) => {
        assert.ok(err instanceof CostError);
        assert.equal(err.message, 'The run was not started: the estimated cost is $0.125, above max-cost $0.1.');
        return true;
      },
    );
    const timed = sumEstimate([
      { label: 'mock/timed', tool: {}, price: { kind: 'per-unit', rate: 0.001, unit: 'second of run time' } },
    ]);
    assert.throws(
      () => enforceMaxCost(timed, 1, 'The run'),
      /can't be confirmed under max-cost \$1 before it runs\. mock\/timed: \$0\.001 per second of run time\. Remove max-cost/,
    );
    const metered = sumEstimate([{ label: 'video', tool: {}, price: { kind: 'metered', note: '$0.1 per second' } }]);
    assert.throws(
      () => enforceMaxCost(metered, 1, 'The run'),
      /video: the run sets its price when it ends \(\$0\.1 per second\)/,
    );
    const onlyLlm = sumEstimate([{ label: 'chat', tool: llm, price: { kind: 'metered' } }]);
    assert.equal(onlyLlm.value, null);
    assert.doesNotThrow(() => enforceMaxCost(onlyLlm, 0.01, 'The run'));
  });

  it('formats amounts for messages', () => {
    assert.equal(formatUsd(0.125), '0.125');
    assert.equal(formatUsd(0.0002341938), '0.000234');
    assert.equal(formatUsd(0.00000042), '0.00000042');
    assert.equal(formatUsd(2), '2');
  });
});

describe('estimateChat', () => {
  const model = {
    id: 'openai/gpt-5-4-mini',
    pricing: { prompt: '0.000001', completion: '0.000002' },
    max_tokens: 1000,
  };
  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Pages /Kids [2 0 R 3 0 R] >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type/Page >>',
  );

  it('counts pages of a PDF', () => {
    assert.equal(countPdfPages(pdf), 2);
    assert.equal(countPdfPages(Buffer.from('not a pdf')), 1);
  });

  it('counts pages kept in compressed object streams', () => {
    const objects = deflateSync(
      Buffer.from('<< /Type /Pages /Count 40 /Kids [] >> << /Type /Page >> << /Type /Page >>'),
    );
    const compressed = Buffer.concat([
      Buffer.from(
        `%PDF-1.7\n5 0 obj\n<< /Type /ObjStm /N 3 /First 20 /Filter /FlateDecode /Length ${objects.length} >>\nstream\n`,
      ),
      objects,
      Buffer.from('\nendstream\nendobj\n%%EOF\n'),
    ]);
    assert.equal(countPdfPages(compressed), 40, 'the page tree count wins over the page objects found');
  });

  it('takes the rates of the tier the input falls in', () => {
    const tiered = {
      pricing: { prompt: '0.0000001', completion: '0.0000004' },
      x_wiro: {
        pricing_tiers: [
          { maxInputTokens: 128000, prompt: '0.0000001', completion: '0.0000004' },
          { minInputTokensExclusive: 128000, prompt: '0.0000002', completion: '0.0000008' },
        ],
      },
    };
    assert.deepEqual(tokenRates(tiered, 1000), { prompt: 0.0000001, completion: 0.0000004 });
    assert.deepEqual(tokenRates(tiered, 200000), { prompt: 0.0000002, completion: 0.0000008 });
    assert.deepEqual(tokenRates({ pricing: { prompt: '1', completion: '2' } }, 5), { prompt: 1, completion: 2 });
    const body = { model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'x'.repeat(600000) }] };
    assert.equal(
      estimateChat({ body, model: { ...tiered, max_tokens: 1000 } }).value,
      200000 * 0.0000002 + 100 * 0.0000008,
    );
  });

  it('estimates the input from the messages and the output from the limit', () => {
    const body = {
      model: model.id,
      max_tokens: 500,
      messages: [
        { role: 'system', content: 'x'.repeat(300) },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'y'.repeat(600) },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            {
              type: 'file',
              file: { filename: 'a.pdf', file_data: `data:application/pdf;base64,${pdf.toString('base64')}` },
            },
          ],
        },
      ],
    };
    const estimate = estimateChat({ body, model });
    assert.equal(estimate.inputTokens, 300 + 1600 + 3200);
    assert.equal(estimate.outputTokens, 500);
    assert.equal(estimate.value.toFixed(4), (5100 * 0.000001 + 500 * 0.000002).toFixed(4));
  });

  it("uses the model's output limit without max_tokens, and knows nothing without prices", () => {
    const body = { model: model.id, messages: [{ role: 'user', content: 'Hi' }] };
    assert.equal(estimateChat({ body, model }).outputTokens, 1000);
    assert.equal(estimateChat({ body, model: { id: 'hosted', pricing: null } }).value, null);
    assert.equal(estimateChat({ body, model: null }).value, null);
  });
});
