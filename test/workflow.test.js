import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { InputError, TaskError } from '../src/errors.js';
import { enforceMaxCost } from '../src/pricing.js';
import { createRunApi } from '../src/wiro.js';
import {
  checkWorkflowInputs,
  creatorFee,
  estimateWorkflowCost,
  parseWorkflowSlug,
  resolveStepValue,
  runWorkflow,
  startValues,
  stepsToRun,
  submitWorkflowRun,
  workflowResults,
} from '../src/workflow.js';
import { captureLog } from './helpers.js';
import { API_KEY, startMockServer } from './mock-server.js';

/** @type {Awaited<ReturnType<typeof startMockServer>>} */
let mock;
/** @type {import('../src/wiro.js').RunApi} */
let api;
before(async () => {
  mock = await startMockServer();
  api = createRunApi({ apiUrl: mock.apiUrl, apiKey: API_KEY });
});
after(() => mock.close());

const detail = async (slug) => (await api.workflowDetail(slug)).workflow[0];

describe('parseWorkflowSlug', () => {
  it('takes a full slug or a link', () => {
    assert.equal(parseWorkflowSlug('product-ad-a1B2c'), 'product-ad-a1B2c');
    assert.equal(parseWorkflowSlug(' https://wiro.ai/workflows/product-ad-a1B2c '), 'product-ad-a1B2c');
    assert.equal(parseWorkflowSlug('https://wiro.ai/workflows/product-ad-a1B2c/?tab=runs#top'), 'product-ad-a1B2c');
  });

  it('refuses anything else', () => {
    assert.throws(() => parseWorkflowSlug(''), /`workflow` is required in workflow mode/);
    assert.throws(() => parseWorkflowSlug('product-ad'), /must be a full workflow slug/);
    assert.throws(() => parseWorkflowSlug('https://wiro.ai/workflows'), InputError);
  });
});

describe('workflow inputs', () => {
  it('checks names and required inputs before the run', async () => {
    const workflow = await detail('promo-video-AbC12');
    assert.doesNotThrow(() => checkWorkflowInputs(workflow, 'promo-video-AbC12', { brief: 'x' }, ['logo']));
    assert.throws(
      () => checkWorkflowInputs(workflow, 'promo-video-AbC12', { brief: 'x', colour: 'red' }, []),
      /promo-video-AbC12 has no input named `colour`\. Its inputs are `brief`, `ratio`, `logo`\./,
    );
    assert.throws(
      () => checkWorkflowInputs(workflow, 'promo-video-AbC12', { ratio: '1:1' }, []),
      /promo-video-AbC12 needs a value for `brief`/,
    );
    assert.throws(
      () => checkWorkflowInputs(workflow, 'promo-video-AbC12', { brief: 'x', logo: 'https://x' }, ['logo']),
      /`logo` is set in both `files` and `params`/,
    );
  });

  it('fills Start values from the given, saved and default values', () => {
    const contents = {
      schema: { input: { a: { defaultValue: 'A' }, b: { defaultValue: 'B' }, c: { defaultValue: '' } } },
      metadata: { input: { values: { b: 'saved' } } },
    };
    assert.deepEqual(startValues(contents, { a: 'given' }), { a: 'given', b: 'saved' });
    assert.deepEqual(startValues(JSON.stringify(contents), {}), { a: 'A', b: 'saved' });
  });

  it('runs only the steps that lead to the End node', async () => {
    const workflow = await detail('promo-video-AbC12');
    assert.deepEqual(stepsToRun(workflow.contents.nodes), ['node-llm', 'node-image', 'node-video']);
  });
});

describe('estimateWorkflowCost', () => {
  it('sums the step prices for the run and leaves out LLM token use', async () => {
    const workflow = await detail('promo-video-AbC12');
    const estimate = await estimateWorkflowCost(
      api,
      workflow,
      startValues(workflow.contents, { brief: 'x' }),
      captureLog(),
    );
    assert.equal(estimate.value.toFixed(3), '0.130', 'image 0.005 + video 0.125; the unused step is left out');
    assert.deepEqual(
      estimate.parts.map((part) => [part.label, part.price.kind, part.llm]),
      [['node-llm (mock/llm)', 'metered', true]],
    );
  });

  it("uses Wiro AI's estimate when the steps are hidden", async () => {
    const workflow = await detail('hidden-steps-HiDe1');
    const estimate = await estimateWorkflowCost(api, workflow, {}, captureLog());
    assert.deepEqual(estimate, { value: 0.42, parts: [], source: 'server' });
  });

  it('reports the hidden steps that estimate cannot price, so max-cost stops the run', async () => {
    const workflow = await detail('hidden-perunit-HiDe2');
    const estimate = await estimateWorkflowCost(api, workflow, {}, captureLog());
    assert.equal(estimate.value, 0.14);
    assert.deepEqual(estimate.parts, [
      { label: 'A hidden step', price: { kind: 'unknown', reason: 'per-unit' }, llm: false },
    ]);
    assert.throws(
      () => enforceMaxCost(estimate, 0.5, 'The workflow run'),
      /can't be confirmed under max-cost \$0\.5 before it runs\. A hidden step: it is priced per unit of use\./,
    );
  });

  it('knows nothing about hidden steps without an estimate', async () => {
    const workflow = { ...(await detail('hidden-steps-HiDe1')), estimatedcost: undefined };
    const estimate = await estimateWorkflowCost(api, workflow, {}, captureLog());
    assert.equal(estimate.value, null);
  });

  it("adds the creator's fee of a priced gallery workflow", async () => {
    const workflow = await detail('priced-gallery-PrIc1');
    assert.equal(creatorFee(workflow), 0.05);
    assert.equal(creatorFee({ clonedfromid: 7, runchargeamount: '0.03' }), 0.03);
    assert.equal(
      creatorFee({ ismonetized: 1, amount: '0.05', ispublic: 0, status: 2 }),
      0,
      'not listed, so not for sale',
    );
    const estimate = await estimateWorkflowCost(
      api,
      workflow,
      startValues(workflow.contents, { brief: 'x' }),
      captureLog(),
    );
    assert.equal(estimate.value, 0.18);
  });

  it('counts each item of a list input', () => {
    assert.deepEqual(resolveStepValue(['$input.photos'], { photos: ['a.png', 'b.png'] }), ['a.png', 'b.png']);
    assert.deepEqual(resolveStepValue(['$node-a.outputs', 'https://x/c.png'], {}), [
      { earlierStep: true },
      'https://x/c.png',
    ]);
  });

  it('cannot price a step whose model it cannot read', async () => {
    const workflow = {
      contents: {
        nodes: {
          'node-a': { tool: 'mock/missing', depends: ['input'], input: {} },
          output: { depends: ['node-a'], fields: { a: '$node-a.outputs' } },
        },
      },
    };
    const estimate = await estimateWorkflowCost(api, workflow, {}, captureLog());
    assert.equal(estimate.value, null);
    assert.equal(estimate.parts[0].price.kind, 'unknown');
  });
});

describe('workflowResults', () => {
  it('reads each End field from the step it references', () => {
    const results = workflowResults({
      workflowrun: {
        contents: {
          output: {
            video: '$node-video.outputs',
            caption: '$node-llm.outputs',
            parts: '$node-split.text2',
            merged: '$node-merge.result',
            missing: '$node-gone.outputs',
          },
        },
      },
      workflowrunnodes: [
        {
          nodeId: 'node-video',
          outputs: [{ name: 'a.mp4', contenttype: 'video/mp4', size: '9', url: 'https://cdn/a.mp4', id: 'x' }],
        },
        { nodeId: 'node-llm', outputs: [{ contenttype: 'raw', content: { answer: ['Hello'] } }] },
        { nodeId: 'node-split', outputs: { text1: ['one'], text2: ['two'] } },
        {
          nodeId: 'node-merge',
          outputs: { result: ['joined text', 'https://cdn/b.png', 'https://cdn/c.png is the cover\n::warning::x'] },
        },
      ],
    });
    assert.deepEqual(results, {
      video: [{ name: 'a.mp4', contenttype: 'video/mp4', size: 9, url: 'https://cdn/a.mp4' }],
      caption: [{ contenttype: 'raw', text: 'Hello' }],
      parts: [{ text: 'two' }],
      merged: [
        { text: 'joined text' },
        { url: 'https://cdn/b.png' },
        { text: 'https://cdn/c.png is the cover\n::warning::x' },
      ],
      missing: [],
    });
  });

  it('reads the End fields of a hidden workflow from its End node', () => {
    const results = workflowResults({
      workflowrun: { contents: { nodes: { output: { fields: { image: '$node-x.outputs' } } }, output: {} } },
      workflowrunnodes: [{ nodeId: 'node-x', outputs: [{ name: 'cat.png', url: 'https://cdn/cat.png' }] }],
    });
    assert.deepEqual(results, { image: [{ name: 'cat.png', url: 'https://cdn/cat.png' }] });
  });
});

describe('runWorkflow', () => {
  const run = (slug, options = {}) =>
    runWorkflow({
      api,
      slug,
      input: options.input ?? { brief: 'A paper boat' },
      timeoutMs: options.timeoutMs ?? 10_000,
      pollMs: 10,
      log: options.log ?? captureLog(),
      onRun: options.onRun,
    });

  it('runs a workflow and returns what its End node shows', async () => {
    const log = captureLog();
    let token;
    const result = await run('promo-video-AbC12', { log, onRun: (handle) => (token = handle.token) });
    assert.equal(result.handle.token, token);
    assert.deepEqual(result.urls, [`${mock.origin}/files/promo.mp4`]);
    assert.equal(result.text, 'A short caption.');
    assert.equal(result.cost, '0.13');
    assert.deepEqual(Object.keys(result.results), ['video', 'caption']);
    assert.ok(log.lines.info.includes('Step node-video (mock/video): completed'));
    assert.deepEqual(mock.state.workflowRunCalls.at(-1), {
      slug: 'promo-video-AbC12',
      input: { brief: 'A paper boat' },
    });
  });

  it('reads the results of a workflow whose steps are hidden', async () => {
    const result = await run('hidden-steps-HiDe1', { input: {} });
    assert.deepEqual(result.urls, [`${mock.origin}/files/cat.png`]);
  });

  it('fails with the step that failed', async () => {
    await assert.rejects(run('broken-run-XyZ98'), (err) => {
      assert.ok(err instanceof TaskError);
      assert.equal(
        err.message,
        'The workflow run failed. node-video (mock/video) failed (tool-error): The duration is out of range..',
      );
      return true;
    });
  });

  it('stops waiting when the timeout runs out, and says the run goes on', async () => {
    const stops = mock.state.kills.length + mock.state.cancels.length;
    await assert.rejects(
      run('slow-run-SlOw1', { timeoutMs: 200 }),
      /did not finish within 0 s\. The run keeps going on Wiro AI, and its results appear there when it ends\./,
    );
    assert.equal(mock.state.kills.length + mock.state.cancels.length, stops, 'no step is stopped');
  });

  it('tries again after a concurrency refusal', async () => {
    const handle = await submitWorkflowRun(api, 'busy-run-BuSy1', { brief: 'x' }, Date.now() + 5_000, captureLog(), 10);
    assert.match(handle.token, /^wfrun\d+$/);
    assert.equal(mock.state.workflowRunCounts['busy-run-BuSy1'], 2);
  });

  it('passes on what the API refuses', async () => {
    await assert.rejects(
      run('promo-video-AbC12', { input: { brief: 'x', colour: 'red' } }),
      /Unknown input field\(s\): colour/,
    );
    await assert.rejects(run('nope-nope-AAAAA'), /Workflow not found/);
  });
});

describe('uploads for workflow inputs', () => {
  it('uploads a local file and returns its URL', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wiro-wf-'));
    const file = path.join(dir, 'logo.png');
    await writeFile(file, 'png bytes');
    const uploaded = await api.uploadFile(file);
    assert.equal(uploaded.url, `${mock.origin}/files/up-logo.png`);
    assert.deepEqual(mock.state.uploads.at(-1), { name: 'file', filename: 'logo.png', type: 'image/png', size: 9 });
  });
});
