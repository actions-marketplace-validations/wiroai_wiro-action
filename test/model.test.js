import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { InputError, TaskError, WiroApiError } from '../src/errors.js';
import {
  buildMultipart,
  extractText,
  formatCost,
  normalizeOutputs,
  readParameterTypes,
  runModel,
  stopTask,
  submitRun,
  urlFieldFor,
} from '../src/model.js';
import { createRunApi } from '../src/wiro.js';
import { captureLog } from './helpers.js';
import { API_KEY, API_SECRET, startMockServer } from './mock-server.js';

/** @type {Awaited<ReturnType<typeof startMockServer>>} */
let mock;
before(async () => {
  mock = await startMockServer();
});
after(() => mock.close());

const model = (id) => {
  const [owner, project] = id.split('/');
  return { id, owner, project };
};

function run(id, options = {}) {
  const log = options.log ?? captureLog();
  const api = options.api ?? createRunApi({ apiUrl: mock.apiUrl, apiKey: API_KEY });
  return runModel({
    api,
    model: model(id),
    params: options.params ?? { prompt: 'A paper boat' },
    files: options.files ?? {},
    timeoutMs: options.timeoutMs ?? 10_000,
    pollMs: options.pollMs ?? 10,
    cancelOnTimeout: options.cancelOnTimeout ?? true,
    log,
    onTask: options.onTask,
    refusalLimitMs: options.refusalLimitMs,
  });
}

describe('runModel', () => {
  it('runs a model, waits for it and returns its outputs', async () => {
    const log = captureLog();
    let started;
    const result = await run('mock/image', { log, onTask: (handle) => (started = handle.taskId) });
    assert.equal(result.handle.taskId, started);
    assert.equal(result.urls.length, 2);
    assert.match(result.urls[0], /\/files\/0\.png$/);
    assert.equal(result.cost, '0.005');
    assert.equal(result.text, '', 'log lines of file models are not text');
    assert.deepEqual(Object.keys(result.outputs[0]).sort(), ['contenttype', 'name', 'size', 'url']);
    assert.equal(result.outputs[0].size, 68);
    assert.ok(log.lines.info.includes('Status: task_postprocess_end'));
    const sent = mock.state.runs.at(-1);
    assert.equal(sent.model, 'mock/image');
    assert.deepEqual(sent.body, { prompt: 'A paper boat' });
    assert.equal(sent.contentType, 'application/json');
  });

  it('returns the answer segments of an LLM', async () => {
    const result = await run('mock/llm');
    assert.equal(result.text, 'Hello from the mock.');
    assert.equal(result.cost, '0.00000815');
    assert.deepEqual(result.urls, []);
  });

  it('reads the text file a speech-to-text model returns', async () => {
    const result = await run('mock/transcribe');
    assert.equal(result.text, 'Hello from the mock transcript.');
    assert.equal(result.urls.length, 1);
  });

  it('keeps waiting through an interim task_error', async () => {
    const result = await run('mock/task-error');
    assert.equal(result.urls.length, 1);
  });

  it('keeps waiting through a failed status check', async () => {
    const result = await run('mock/flaky');
    assert.equal(result.urls.length, 1);
  });

  it('fails with the error of a failed run', async () => {
    await assert.rejects(run('mock/fail'), (err) => {
      assert.ok(err instanceof TaskError);
      assert.match(err.message, /exit code 1\): The input image could not be read\./);
      return true;
    });
  });

  it('fails when the task is cancelled', async () => {
    await assert.rejects(run('mock/cancelled'), /was cancelled/);
  });

  it('stops a running task with Task/Kill when the timeout runs out', async () => {
    const kills = mock.state.kills.length;
    await assert.rejects(run('mock/slow', { timeoutMs: 300, pollMs: 20 }), (err) => {
      assert.ok(err instanceof TaskError);
      assert.match(err.message, /did not finish within 0 s \(last status: task_start\)\. It was stopped\./);
      return true;
    });
    assert.equal(mock.state.kills.length, kills + 1);
  });

  it('stops a queued task with Task/Cancel', async () => {
    const cancels = mock.state.cancels.length;
    await assert.rejects(run('mock/queued', { timeoutMs: 200, pollMs: 20 }), /task_queue\)\. It was stopped\./);
    assert.equal(mock.state.cancels.length, cancels + 1);
  });

  it('leaves the task running when cancel-on-timeout is off', async () => {
    const stops = mock.state.kills.length + mock.state.cancels.length;
    await assert.rejects(
      run('mock/slow', { timeoutMs: 200, pollMs: 20, cancelOnTimeout: false }),
      /It is still running\./,
    );
    assert.equal(mock.state.kills.length + mock.state.cancels.length, stops);
  });

  it('stops the task when status checks keep being refused', async () => {
    const stops = mock.state.kills.length + mock.state.cancels.length;
    await assert.rejects(run('mock/lost', { refusalLimitMs: 100, pollMs: 20 }), (err) => {
      assert.ok(err instanceof TaskError);
      assert.match(err.message, /^Stopped waiting for task \d+: task-not-founded The task was stopped\.$/);
      return true;
    });
    assert.equal(mock.state.kills.length + mock.state.cancels.length, stops + 1);
  });

  it('signs requests for signature projects', async () => {
    const api = createRunApi({ apiUrl: mock.apiUrl, apiKey: API_KEY, apiSecret: API_SECRET });
    const result = await run('mock/image', { api });
    assert.equal(result.urls.length, 2);
    const headers = mock.state.runs.at(-1).headers;
    assert.ok(headers['x-nonce'] && headers['x-signature']);
  });

  it('explains a rejected key', async () => {
    const api = createRunApi({ apiUrl: mock.apiUrl, apiKey: API_KEY, apiSecret: 'wrong' });
    await assert.rejects(run('mock/image', { api }), (err) => {
      assert.ok(err instanceof WiroApiError);
      assert.equal(err.status, 401);
      assert.match(err.message, /Project authorization is not founded\. Check `api-key`/);
      return true;
    });
  });

  it('explains an unknown model and a low balance', async () => {
    await assert.rejects(run('mock/missing'), /Wiro AI has no model `mock\/missing`/);
    await assert.rejects(
      run('mock/balance'),
      /Insufficient balance\. Add funds at https:\/\/wiro\.ai\/panel\/billing\./,
    );
  });
});

describe('submitRun', () => {
  it('tries again after a concurrency refusal', async () => {
    const api = createRunApi({ apiUrl: mock.apiUrl, apiKey: API_KEY });
    const log = captureLog();
    const handle = await submitRun(api, model('mock/busy'), {}, Date.now() + 5_000, log, 10);
    assert.ok(handle.taskId);
    assert.equal(mock.state.runCounts['mock/busy'], 3);
    assert.equal(log.lines.info.filter((line) => line.includes('concurrent task limit')).length, 2);
  });
});

describe('stopTask', () => {
  it('falls back to the other call', async () => {
    const calls = [];
    const api = {
      cancel: async () => {
        calls.push('cancel');
        throw new WiroApiError('Task is not in a cancellable state.');
      },
      kill: async () => {
        calls.push('kill');
        return { result: true };
      },
    };
    const stopped = await stopTask(
      /** @type {any} */ (api),
      { taskId: '1', token: 't', status: 'task_queue' },
      captureLog(),
    );
    assert.equal(stopped, true);
    assert.deepEqual(calls, ['cancel', 'kill']);
  });
});

describe('file uploads', () => {
  /** @type {string} */
  let dir;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'wiro-upload-'));
    for (const name of ['photo.png', 'a.pdf', 'b.pdf', 'shirt.jpg']) {
      await writeFile(path.join(dir, name), `content of ${name}`);
    }
  });

  it('names the URL field of each file parameter', () => {
    assert.equal(urlFieldFor('inputImage', 'fileinput'), 'inputImageUrl');
    assert.equal(urlFieldFor('inputDocumentMultiple', 'multifileinput'), 'inputDocumentUrlMultiple');
    assert.equal(urlFieldFor('inputImages', 'multifileinput'), 'inputImagesUrlMultiple');
    assert.equal(urlFieldFor('inputImageMultiple', 'multifileinputdrop'), 'inputImageUrlMultiple');
    assert.equal(urlFieldFor('inputImageClothes', 'combinefileinput'), undefined);
  });

  it('sends files as multipart with the field types from Tool/Detail', async () => {
    const result = await run('mock/upload', {
      params: { prompt: 'Upscale', scale: 2, inputImageClothes: 'https://example.com/pants.jpg' },
      files: {
        inputImage: [path.join(dir, 'photo.png')],
        inputDocumentMultiple: [path.join(dir, 'a.pdf'), path.join(dir, 'b.pdf')],
        inputImageMultiple: [path.join(dir, 'photo.png'), path.join(dir, 'shirt.jpg')],
        inputImageClothes: [path.join(dir, 'shirt.jpg')],
      },
    });
    assert.equal(result.urls.length, 1);
    const sent = mock.state.runs.at(-1);
    assert.match(sent.contentType, /^multipart\/form-data; boundary=/);
    const fields = sent.fields.map((field) =>
      field.filename !== undefined
        ? `${field.name}=@${field.filename} (${field.type})`
        : `${field.name}=${field.value}`,
    );
    assert.deepEqual(fields, [
      'prompt=Upscale',
      'scale=2',
      'inputImage=@photo.png (image/png)',
      'inputImageUrl=',
      'inputDocumentMultiple=@a.pdf (application/pdf)',
      'inputDocumentMultiple=@b.pdf (application/pdf)',
      'inputDocumentUrlMultiple=',
      'inputImageMultiple=@photo.png (image/png)',
      'inputImageMultiple=@shirt.jpg (image/jpeg)',
      'inputImageUrlMultiple=',
      'inputImageClothes=@shirt.jpg (image/jpeg)',
      'inputImageClothes=https://example.com/pants.jpg',
    ]);
  });

  it('rejects parameters the model does not have or that take no files', async () => {
    const api = createRunApi({ apiUrl: mock.apiUrl, apiKey: API_KEY });
    const types = await readParameterTypes(api, model('mock/upload'), captureLog());
    const build = (files, params = {}) => buildMultipart({ params, files, types, model: model('mock/upload') });
    await assert.rejects(build({ image: [path.join(dir, 'photo.png')] }), (err) => {
      assert.ok(err instanceof InputError);
      assert.match(
        err.message,
        /no parameter named `image`\. Its file parameters are `inputImage`, `inputDocumentMultiple`, `inputImageMultiple`, `inputImageClothes`\./,
      );
      return true;
    });
    await assert.rejects(build({ prompt: [path.join(dir, 'photo.png')] }), /`prompt` is a textarea parameter/);
    await assert.rejects(
      build({ inputImage: [path.join(dir, 'photo.png'), path.join(dir, 'shirt.jpg')] }),
      /takes one file, but 2 match/,
    );
    await assert.rejects(
      build({ inputImage: [path.join(dir, 'photo.png')] }, { inputImageUrl: 'https://example.com/a.png' }),
      /a URL in `params.inputImageUrl`/,
    );
    await assert.rejects(
      build({ inputImage: [path.join(dir, 'photo.png')] }, { inputImage: 'x' }),
      /set in both `files` and `params`/,
    );
  });

  it('sends files as given when the parameter list is not available', async () => {
    const log = captureLog();
    const api = createRunApi({ apiUrl: mock.apiUrl, apiKey: API_KEY });
    const types = await readParameterTypes(api, model('mock/image'), log);
    assert.equal(types, null);
    assert.match(log.lines.warning[0], /Could not read the parameters of mock\/image/);
    const form = await buildMultipart({
      params: { prompt: 'x', options: { a: 1 } },
      files: { inputImage: [path.join(dir, 'photo.png')] },
      types,
      model: model('mock/image'),
    });
    assert.deepEqual([...form.keys()], ['prompt', 'options', 'inputImage']);
    assert.equal(form.get('options'), '{"a":1}');
  });
});

describe('outputs', () => {
  it('drops internal fields', () => {
    const outputs = normalizeOutputs({
      outputs: [
        {
          id: 'x',
          accesskey: 'secret',
          uuid: 'u',
          name: 'a.png',
          contenttype: 'image/png',
          size: '12',
          url: 'https://cdn/a.png',
        },
        null,
      ],
    });
    assert.deepEqual(outputs, [{ name: 'a.png', contenttype: 'image/png', size: 12, url: 'https://cdn/a.png' }]);
  });

  it('finds the text of LLMs and text models', () => {
    const raw = (content) => ({ outputs: [{ contenttype: 'raw', content }], debugoutput: 'merged text' });
    const text = (task) => extractText(task, normalizeOutputs(task));
    assert.equal(
      text(
        raw({
          segments: [
            { type: 'thinking', text: 'hm' },
            { type: 'answer', text: 'Hi ' },
            { type: 'answer', text: 'there' },
          ],
        }),
      ),
      'Hi there',
    );
    assert.equal(text(raw({ answer: ['From answer'] })), 'From answer');
    assert.equal(text(raw({ raw: ' From raw ' })), 'From raw');
    assert.equal(text(raw({})), 'merged text');
    assert.equal(text({ outputs: [], debugoutput: ' transcript ' }), 'transcript');
    assert.equal(text({ outputs: [{ url: 'https://cdn/a.png' }], debugoutput: 'Request started.' }), '');
  });

  it('formats costs as plain decimals', () => {
    assert.equal(formatCost('0.003510000000'), '0.00351');
    assert.equal(formatCost(0.0000000123), '0.0000000123');
    assert.equal(formatCost('0'), '0');
    assert.equal(formatCost(1.5), '1.5');
    assert.equal(formatCost(undefined), '');
    assert.equal(formatCost('n/a'), '');
  });
});
