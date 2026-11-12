// A small stand-in for the Wiro AI Run API and LLM gateway, used by the tests and by
// the CI job that runs the action. Run it with `node test/mock-server.js --port 8787`.
//
// Run API:     http://127.0.0.1:<port>/v1/...
// LLM gateway: http://127.0.0.1:<port>/llm/v1/...
// Credentials: API key `test-key`, secret `test-secret` (signature or Bearer key:secret).
//
// The model ID picks the scenario, see RUN_MODELS and CHAT_MODELS below.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const API_KEY = 'test-key';
export const API_SECRET = 'test-secret';

// A 1x1 PNG.
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

export const TRANSCRIPT = 'Hello from the mock transcript.\n';

const DONE = 'task_postprocess_end';

/**
 * Each scenario is a list of Task/Detail answers; the last one repeats.
 * @type {Record<string, (base: string) => { run?: (count: number) => object | undefined, steps: object[] }>}
 */
const RUN_MODELS = {
  'mock/image': (base) => ({
    steps: [
      { status: 'task_queue' },
      { status: 'task_start' },
      { status: 'task_output' },
      {
        status: DONE,
        pexit: '0',
        totalcost: '0.005000000000',
        elapsedseconds: '3.0000',
        debugoutput: 'Request started.\nRequest ended.\n',
        outputs: [
          {
            id: 'f1',
            name: '0.png',
            contenttype: 'image/png',
            size: '68',
            accesskey: 'internal',
            url: `${base}/files/0.png`,
          },
          {
            id: 'f2',
            name: '0.png',
            contenttype: 'image/png',
            size: '68',
            accesskey: 'internal',
            url: `${base}/files/1.png`,
          },
        ],
      },
    ],
  }),
  'mock/llm': () => ({
    steps: [
      { status: 'task_start' },
      {
        status: DONE,
        pexit: '0',
        totalcost: '0.000008150000',
        debugoutput: 'Thinking it over. Hello from the mock.',
        outputs: [
          {
            contenttype: 'raw',
            content: {
              prompt: 'Say hello',
              raw: 'Thinking it over. Hello from the mock.',
              thinking: ['Thinking it over.'],
              answer: [' Hello from the mock. '],
              segments: [
                { type: 'thinking', text: 'Thinking it over.' },
                { type: 'answer', text: ' Hello from the mock. ' },
              ],
              finishreason: 'stop',
            },
          },
        ],
      },
    ],
  }),
  'mock/fail': () => ({
    steps: [
      { status: 'task_start' },
      { status: DONE, pexit: '1', totalcost: '0', debugerror: 'The input image could not be read.', outputs: [] },
    ],
  }),
  'mock/cancelled': () => ({ steps: [{ status: 'task_queue' }, { status: 'task_cancel', pexit: '' }] }),
  'mock/slow': () => ({ steps: [{ status: 'task_queue' }, { status: 'task_start' }] }),
  'mock/queued': () => ({ steps: [{ status: 'task_queue' }] }),
  'mock/task-error': (base) => ({
    steps: [
      { status: 'task_error', debugerror: 'Retrying on another worker.' },
      {
        status: DONE,
        pexit: '0',
        totalcost: '0.001',
        outputs: [{ name: 'a.png', contenttype: 'image/png', url: `${base}/files/a.png` }],
      },
    ],
  }),
  'mock/flaky': (base) => ({
    flakyDetail: 1,
    steps: [
      {
        status: DONE,
        pexit: '0',
        totalcost: '0.001',
        outputs: [{ name: 'a.png', contenttype: 'image/png', url: `${base}/files/a.png` }],
      },
    ],
  }),
  'mock/busy': (base) => ({
    run: (count) =>
      count <= 2
        ? {
            result: false,
            errors: [{ code: 96, message: 'You have reached your concurrent task limit.' }],
          }
        : undefined,
    steps: [
      {
        status: DONE,
        pexit: '0',
        totalcost: '0.001',
        outputs: [{ name: 'a.png', contenttype: 'image/png', url: `${base}/files/a.png` }],
      },
    ],
  }),
  'mock/balance': () => ({
    run: () => ({ result: false, errors: [{ code: 97, message: 'Insufficient balance' }] }),
    steps: [],
  }),
  'mock/upload': (base) => ({
    steps: [
      {
        status: DONE,
        pexit: '0',
        totalcost: '0.002',
        outputs: [{ name: 'out.png', contenttype: 'image/png', url: `${base}/files/out.png` }],
      },
    ],
  }),
  'mock/transcribe': (base) => ({
    steps: [
      {
        status: DONE,
        pexit: '0',
        totalcost: '0.0002',
        debugoutput: 'Request started.\nRequest ended.\n',
        outputs: [
          {
            name: '1_output.txt',
            contenttype: 'text/plain',
            size: String(Buffer.byteLength(TRANSCRIPT)),
            url: `${base}/files/1_output.txt`,
          },
        ],
      },
    ],
  }),
  // Task/Detail never finds this task.
  'mock/lost': () => ({ lostDetail: true, steps: [{ status: 'task_start' }] }),
  // Run answers after a delay, as it does while it stores uploaded files.
  'mock/slowstart': () => ({ runDelayMs: 1_500, steps: [{ status: 'task_start' }] }),
  'mock/video': (base) => ({
    steps: [
      { status: 'task_start' },
      {
        status: DONE,
        pexit: '0',
        totalcost: '0.125',
        outputs: [{ name: 'clip.mp4', contenttype: 'video/mp4', size: '68', url: `${base}/files/clip.mp4` }],
      },
    ],
  }),
  'mock/voice': (base) => ({
    steps: [
      {
        status: DONE,
        pexit: '0',
        totalcost: '0.00048',
        outputs: [{ name: 'speech.mp3', contenttype: 'audio/mpeg', size: '68', url: `${base}/files/speech.mp3` }],
      },
    ],
  }),
  'mock/timed': (base) => ({
    steps: [
      {
        status: DONE,
        pexit: '0',
        totalcost: '0.004',
        outputs: [{ name: 'a.png', contenttype: 'image/png', url: `${base}/files/a.png` }],
      },
    ],
  }),
};

const select = (id, defaultvalue, values) => ({
  id,
  type: 'select',
  defaultvalue,
  options: values.map((value) => ({ value })),
});

/** Tool/Detail entries: parameters, categories and price lists. */
const TOOLS = {
  'mock/upload': {
    categories: ['image-to-image'],
    parameters: [
      { id: 'inputImage', type: 'fileinput' },
      { id: 'inputDocumentMultiple', type: 'multifileinput' },
      { id: 'inputImageMultiple', type: 'multifileinputdrop' },
      { id: 'inputImageClothes', type: 'combinefileinput' },
      { id: 'prompt', type: 'textarea' },
      { id: 'scale', type: 'number' },
    ],
    dynamicprice: [{ inputs: { inputImage: 'QUANTITY:1' }, price: 0.002, priceMethod: 'cpr' }],
  },
  'mock/image': {
    categories: ['text-to-image'],
    parameters: [
      { id: 'prompt', type: 'textarea', required: true, defaultvalue: 'A sample prompt' },
      select('aspectRatio', '1:1', ['1:1', '16:9']),
    ],
    dynamicprice: [{ inputs: {}, price: 0.005, priceMethod: 'cpr' }],
  },
  'mock/video': {
    categories: ['text-to-video', 'image-to-video'],
    parameters: [
      { id: 'inputImage', type: 'combinefileinput', defaultvalue: 'https://example.com/sample.png' },
      { id: 'prompt', type: 'textarea', defaultvalue: 'A sample prompt' },
      select('duration', '5', ['5', '10']),
      select('resolution', '720p', ['720p', '1080p']),
    ],
    dynamicprice: [
      { inputs: { duration: '5', resolution: '720p' }, price: 0.125, priceMethod: 'cpr' },
      { inputs: { duration: '10', resolution: '720p' }, price: 0.25, priceMethod: 'cpr' },
      { inputs: { duration: '5', resolution: '1080p' }, price: 0.3, priceMethod: 'cpr' },
    ],
  },
  'mock/llm': {
    categories: ['llm', 'llm-tool-call'],
    parameters: [{ id: 'prompt', type: 'textarea', required: true }],
    dynamicprice: [{ inputs: {}, price: 0, priceMethod: 'cp-readoutput', note: '1 million input token $0.05' }],
  },
  'mock/timed': { categories: ['tool'], parameters: [], dynamicprice: null, cps: 0.001, approximatelycost: 0 },
  'mock/voice': {
    categories: ['text-to-speech'],
    parameters: [
      { id: 'prompt', type: 'textarea', required: true, defaultvalue: 'Showcase text' },
      { ...select('voice', 'alice', ['alice', 'bill']), required: true },
      { ...select('outputFormat', 'mp3_44100_128', ['mp3_22050_32', 'mp3_44100_128']), required: true },
      { id: 'inputAudio', type: 'fileinput', required: true, defaultvalue: 'https://example.com/sample.mp3' },
      { id: 'stability', type: 'float', defaultvalue: '0.5' },
    ],
    dynamicprice: [{ inputs: {}, price: 0.00004, priceMethod: 'cp-promptlength' }],
  },
};

/** The Start fields and steps shared by the mock workflows. */
const promoGraph = () => ({
  version: '1',
  nodes: {
    'node-llm': {
      id: 'node-llm',
      type: 'run',
      tool: 'mock/llm',
      depends: ['input'],
      input: { prompt: '$input.brief' },
    },
    'node-image': {
      id: 'node-image',
      type: 'run',
      tool: 'mock/image',
      depends: ['input', 'node-llm'],
      input: { prompt: '$node-llm.outputs', aspectRatio: '$input.ratio' },
    },
    'node-video': {
      id: 'node-video',
      type: 'run',
      tool: 'mock/video',
      depends: ['node-image', 'node-llm'],
      input: { inputImage: ['$node-image.outputs'], prompt: '$node-llm.outputs', duration: '5', resolution: '720p' },
    },
    // Not wired to the End node, so it never runs and costs nothing.
    'node-unused': {
      id: 'node-unused',
      type: 'run',
      tool: 'mock/video',
      depends: ['input'],
      input: { duration: '10' },
    },
    output: {
      id: 'output',
      type: 'display',
      depends: ['node-video', 'node-llm'],
      input: {},
      fields: { video: '$node-video.outputs', caption: '$node-llm.outputs' },
    },
  },
  output: { video: '$node-video.outputs', caption: '$node-llm.outputs' },
  schema: {
    input: {
      brief: { label: 'Brief', type: 'string', defaultValue: '', ui: { field: 'textarea' } },
      ratio: { label: 'Ratio', type: 'string', defaultValue: '16:9', ui: { field: 'select' } },
      logo: { label: 'Logo', type: 'string', defaultValue: '', ui: { field: 'image' } },
    },
    output: {},
  },
  metadata: { input: { position: { x: 0, y: 0 }, values: {} } },
});

/** Workflow/Detail entries; `run` picks how Workflow/RunDetail answers. */
const WORKFLOWS = {
  'promo-video-AbC12': { title: 'Promo video', requiredinputs: ['brief'], contents: promoGraph(), run: 'complete' },
  'busy-run-BuSy1': { title: 'Busy', requiredinputs: ['brief'], contents: promoGraph(), run: 'complete', busy: 1 },
  'broken-run-XyZ98': { title: 'Broken', requiredinputs: ['brief'], contents: promoGraph(), run: 'fail' },
  'slow-run-SlOw1': { title: 'Slow', requiredinputs: ['brief'], contents: promoGraph(), run: 'slow' },
  // Read from another workspace: the steps are left out and only the End node keeps the
  // result fields, as Wiro AI sends a protected workflow.
  'hidden-steps-HiDe1': {
    title: 'Hidden steps',
    requiredinputs: [],
    estimatedcost: { type: 'estimated', value: 0.42, details: [] },
    contents: hiddenGraph(),
    run: 'hidden',
  },
  'hidden-perunit-HiDe2': {
    title: 'Hidden steps priced per second',
    requiredinputs: [],
    estimatedcost: {
      type: 'estimated',
      value: 0.14,
      details: [{ code: 'per-unit', rate: 0.1, unit: 'second', tool: null, nodeid: null }],
    },
    contents: hiddenGraph(),
    run: 'hidden',
  },
  'priced-gallery-PrIc1': {
    title: 'Priced gallery workflow',
    requiredinputs: ['brief'],
    ismonetized: 1,
    amount: '0.05',
    ispublic: 1,
    status: 2,
    contents: promoGraph(),
    run: 'complete',
  },
};

/** @returns {any} */
function hiddenGraph() {
  return {
    version: '1',
    nodes: {
      output: { id: 'output', type: 'display', depends: ['node-x'], input: {}, fields: { image: '$node-x.outputs' } },
    },
    output: {},
    schema: { input: { topic: { type: 'string', defaultValue: 'cats', ui: { field: 'textarea' } } }, output: {} },
    metadata: { input: { position: { x: 0, y: 0 } } },
  };
}

/** The outputs each mock workflow step returns. */
const stepOutputs = (base) => ({
  'node-llm': [
    {
      contenttype: 'raw',
      content: { answer: ['A short caption.'], segments: [{ type: 'answer', text: 'A short caption.' }] },
    },
  ],
  'node-image': [{ name: 'still.png', contenttype: 'image/png', size: '68', url: `${base}/files/still.png` }],
  'node-video': [{ name: 'promo.mp4', contenttype: 'video/mp4', size: '68', url: `${base}/files/promo.mp4` }],
  'node-x': [{ name: 'cat.png', contenttype: 'image/png', size: '68', url: `${base}/files/cat.png` }],
});

/**
 * The Workflow/RunDetail answer for one poll of a mock run.
 * @param {any} run
 * @param {string} base
 */
function workflowRunDetail(run, base) {
  const outputs = stepOutputs(base);
  const step = (nodeId, tool, status, extra = {}) => ({
    nodeId,
    tool,
    kind: 'tool',
    status,
    cause: null,
    error: null,
    tasktoken: `wf-task-${run.token}-${nodeId}`,
    outputs: status === 'completed' ? outputs[nodeId] : [],
    elapsedseconds: status === 'completed' ? 2 : 0,
    ...extra,
  });
  const graph = run.workflow.contents;
  const contents =
    run.workflow.run === 'hidden'
      ? hiddenGraph()
      : { ...graph, metadata: { input: { position: { x: 0, y: 0 }, values: { ...run.input } } } };
  let status = 'running';
  let nodes;
  if (run.workflow.run === 'hidden') {
    status = 'completed';
    nodes = [step('node-x', null, 'completed')];
  } else if (run.workflow.run === 'slow') {
    status = run.stopped ? 'cancelled' : 'running';
    nodes = [
      step('node-llm', 'mock/llm', 'completed'),
      step('node-image', 'mock/image', 'completed'),
      step('node-video', 'mock/video', run.stopped ? 'cancelled' : 'running'),
    ];
  } else if (run.workflow.run === 'fail' && run.polls >= 2) {
    status = 'failed';
    nodes = [
      step('node-llm', 'mock/llm', 'completed'),
      step('node-image', 'mock/image', 'completed'),
      step('node-video', 'mock/video', 'failed', { cause: 'tool-error', error: 'The duration is out of range.' }),
    ];
  } else if (run.polls >= 3) {
    status = 'completed';
    nodes = [
      step('node-llm', 'mock/llm', 'completed'),
      step('node-image', 'mock/image', 'completed'),
      step('node-video', 'mock/video', 'completed'),
    ];
  } else {
    nodes = [
      step('node-llm', 'mock/llm', run.polls >= 2 ? 'completed' : 'running'),
      step('node-image', 'mock/image', run.polls >= 2 ? 'running' : 'pending'),
      step('node-video', 'mock/video', 'pending'),
    ];
  }
  const ended = status !== 'running';
  return {
    result: true,
    errors: [],
    workflowrun: {
      workflowtoken: run.token,
      workflowslug: run.slug,
      status,
      outcome: ended ? status : null,
      contents,
      totalcost: ended ? '0.13' : '0.005',
      chargedcost: ended ? '0.13' : null,
      elapsedseconds: 6,
      ...(run.workflow.run === 'hidden' ? { graphmasked: true } : {}),
    },
    workflowrunnodes: nodes,
  };
}

/** @param {import('node:http').IncomingMessage} req */
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** @param {string} a @param {string} b */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/** @param {import('node:http').IncomingHttpHeaders} headers */
function runApiAuthorized(headers) {
  if (headers['x-api-key'] !== API_KEY) return false;
  if (!headers['x-signature'] && !headers['x-nonce']) return true;
  const expected = createHmac('sha256', API_KEY)
    .update(API_SECRET + String(headers['x-nonce']))
    .digest('hex');
  return safeEqual(String(headers['x-signature']), expected);
}

/** @param {import('node:http').IncomingHttpHeaders} headers */
function gatewayAuthorized(headers) {
  const auth = String(headers.authorization ?? '');
  return auth === `Bearer ${API_KEY}` || auth === `Bearer ${API_KEY}:${API_SECRET}`;
}

/**
 * Parses a multipart body into a list of fields.
 * @param {Buffer} body
 * @param {string} contentType
 */
async function parseMultipart(body, contentType) {
  const form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
  const fields = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') fields.push({ name, value });
    else fields.push({ name, filename: value.name, type: value.type, size: value.size });
  }
  return fields;
}

/** @param {any} content */
function describeContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const counts = {};
  for (const part of content) counts[part.type] = (counts[part.type] ?? 0) + 1;
  return Object.entries(counts)
    .map(([type, count]) => `${count} ${type}`)
    .join(', ');
}

/**
 * @param {object} [options]
 * @param {number} [options.port] 0 picks a free port
 * @param {string} [options.host]
 */
export async function startMockServer({ port = 0, host = '127.0.0.1' } = {}) {
  const state = {
    runs: /** @type {any[]} */ ([]),
    runCounts: /** @type {Record<string, number>} */ ({}),
    details: 0,
    tasks: new Map(),
    cancels: /** @type {string[]} */ ([]),
    kills: /** @type {string[]} */ ([]),
    toolDetails: 0,
    chats: /** @type {any[]} */ ([]),
    chatCounts: /** @type {Record<string, number>} */ ({}),
    downloads: 0,
    workflowRuns: new Map(),
    workflowRunCalls: /** @type {any[]} */ ([]),
    workflowRunCounts: /** @type {Record<string, number>} */ ({}),
    uploads: /** @type {any[]} */ ([]),
  };
  let nextTask = 1000;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const base = `http://${req.headers.host}`;
    const json = (status, data, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };

    try {
      if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
        state.downloads += 1;
        if (url.pathname.endsWith('.txt')) {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(TRANSCRIPT);
          return;
        }
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
        res.end(PNG);
        return;
      }

      const body = await readBody(req);

      if (url.pathname.startsWith('/v1/')) {
        if (!runApiAuthorized(req.headers)) {
          json(401, { result: false, errors: [{ code: 0, message: 'Project authorization is not founded.' }] });
          return;
        }
        const route = url.pathname.slice(3);
        const run = route.match(/^\/Run\/([^/]+)\/([^/]+)$/);
        if (run) {
          const model = `${decodeURIComponent(run[1])}/${decodeURIComponent(run[2])}`;
          const scenario = RUN_MODELS[model]?.(base);
          const contentType = String(req.headers['content-type'] ?? '');
          const record = { model, contentType, headers: req.headers };
          if (contentType.startsWith('multipart/form-data')) record.fields = await parseMultipart(body, contentType);
          else record.body = JSON.parse(body.toString('utf8') || '{}');
          state.runs.push(record);
          state.runCounts[model] = (state.runCounts[model] ?? 0) + 1;
          if (!scenario) {
            json(200, { result: false, errors: [{ code: 1, message: 'slug-owner-project-not-exist' }] });
            return;
          }
          const refusal = scenario.run?.(state.runCounts[model]);
          if (refusal) {
            json(200, refusal);
            return;
          }
          if (scenario.runDelayMs) await new Promise((resolve) => setTimeout(resolve, scenario.runDelayMs));
          const id = String(nextTask++);
          const token = `token-${id}`;
          state.tasks.set(token, { id, model, polls: 0, scenario, stopped: false });
          json(200, { result: true, errors: [], taskid: id, socketaccesstoken: token });
          return;
        }

        const isJson = String(req.headers['content-type'] ?? '').includes('application/json');
        const data = isJson && body.length ? JSON.parse(body.toString('utf8')) : {};
        if (route === '/Task/Detail') {
          state.details += 1;
          const task = state.tasks.get(data.tasktoken);
          if (!task) {
            json(200, { result: false, errors: [{ code: 0, message: 'task-not-founded' }] });
            return;
          }
          task.polls += 1;
          if (task.scenario.lostDetail && !task.stopped) {
            json(200, { result: false, errors: [{ code: 0, message: 'task-not-founded' }] });
            return;
          }
          if (task.scenario.flakyDetail && task.polls <= task.scenario.flakyDetail) {
            res.writeHead(502, { 'content-type': 'text/html' });
            res.end('<html>Bad gateway</html>');
            return;
          }
          const steps = task.scenario.steps;
          const step = task.stopped
            ? { status: 'task_cancel', pexit: '' }
            : steps[Math.min(task.polls - 1, steps.length - 1)];
          json(200, {
            result: true,
            errors: [],
            total: '1',
            tasklist: [
              {
                id: task.id,
                socketaccesstoken: data.tasktoken,
                debugoutput: '',
                debugerror: '',
                pexit: '',
                outputs: [],
                totalcost: '0',
                modelslugowner: task.model.split('/')[0],
                modelslugproject: task.model.split('/')[1],
                ...step,
              },
            ],
          });
          return;
        }
        if (route === '/Task/Cancel' || route === '/Task/Kill') {
          (route === '/Task/Cancel' ? state.cancels : state.kills).push(data.taskid ?? data.socketaccesstoken);
          const workflowStep = String(data.socketaccesstoken ?? '').match(/^wf-task-(.+)-node-[\w-]+$/);
          if (workflowStep && state.workflowRuns.has(workflowStep[1])) {
            // As on Wiro AI, a step of a workflow run can't be stopped on its own.
            json(200, {
              result: false,
              errors: [{ code: 1, message: "This task belongs to a workflow run, so it can't be stopped on its own." }],
            });
            return;
          }
          const task =
            route === '/Task/Cancel'
              ? [...state.tasks.values()].find((entry) => entry.id === data.taskid)
              : state.tasks.get(data.socketaccesstoken);
          if (!task) {
            json(200, { result: false, errors: [{ code: 1, message: 'There is no task yet.' }] });
            return;
          }
          task.stopped = true;
          json(200, { result: true, errors: [] });
          return;
        }
        if (route === '/Tool/Detail') {
          state.toolDetails += 1;
          const tool = TOOLS[`${data.slugowner}/${data.slugproject}`];
          if (!tool) {
            json(200, { result: false, errors: [{ code: 1, message: 'slug-owner-project-not-exist' }] });
            return;
          }
          const { parameters, ...rest } = tool;
          json(200, {
            result: true,
            errors: [],
            tool: [
              {
                slugowner: data.slugowner,
                slugproject: data.slugproject,
                parameters: [{ title: '', items: parameters }],
                ...rest,
              },
            ],
          });
          return;
        }
        if (route === '/File/Upload') {
          const fields = await parseMultipart(body, String(req.headers['content-type'] ?? ''));
          const file = fields.find((field) => field.name === 'file' && field.filename);
          if (!file) {
            json(200, { result: false, errors: [{ code: 0, message: 'Request files [file] required' }] });
            return;
          }
          state.uploads.push(file);
          json(200, {
            result: true,
            errors: [],
            list: [
              {
                id: `f${state.uploads.length}`,
                name: file.filename,
                contenttype: file.type,
                url: `${base}/files/up-${file.filename}`,
              },
            ],
          });
          return;
        }
        if (route === '/Workflow/Detail') {
          const workflow = WORKFLOWS[data.slug];
          if (!workflow) {
            json(200, { result: false, errors: [{ code: 0, message: 'Workflow not found' }] });
            return;
          }
          const { run: _run, busy: _busy, ...detail } = workflow;
          json(200, {
            result: true,
            errors: [],
            workflow: [{ slug: data.slug.slice(0, -6), slugid: data.slug.slice(-5), ...detail }],
          });
          return;
        }
        if (route === '/Workflow/Run') {
          const workflow = WORKFLOWS[data.slug];
          state.workflowRunCalls.push(data);
          state.workflowRunCounts[data.slug] = (state.workflowRunCounts[data.slug] ?? 0) + 1;
          if (!workflow) {
            json(200, { result: false, errors: [{ code: 0, message: 'Workflow not found' }] });
            return;
          }
          if (workflow.busy && state.workflowRunCounts[data.slug] <= workflow.busy) {
            json(200, {
              result: false,
              errors: [{ code: 96, message: 'You have reached your concurrent task limit.' }],
            });
            return;
          }
          const known = Object.keys(workflow.contents.schema.input);
          const unknown = Object.keys(data.input ?? {}).filter((key) => !known.includes(key));
          if (unknown.length) {
            json(200, {
              result: false,
              errors: [{ code: 0, message: `Unknown input field(s): ${unknown.join(', ')}.` }],
            });
            return;
          }
          const missing = workflow.requiredinputs.find((key) => !(data.input ?? {})[key]);
          if (missing) {
            json(200, {
              result: false,
              errors: [{ code: 0, message: `A required input value is missing: ${missing}.` }],
            });
            return;
          }
          const token = `wfrun${state.workflowRuns.size + 1}`;
          state.workflowRuns.set(token, {
            token,
            slug: data.slug,
            workflow,
            input: data.input ?? {},
            polls: 0,
            stopped: false,
          });
          json(200, { result: true, errors: [], workflowtoken: token });
          return;
        }
        if (route === '/Workflow/RunDetail') {
          const run = state.workflowRuns.get(data.workflowtoken);
          if (!run) {
            json(200, { result: false, errors: [{ code: 0, message: 'There is no workflow run yet.' }] });
            return;
          }
          run.polls += 1;
          json(200, workflowRunDetail(run, base));
          return;
        }
        json(404, { result: false, errors: [{ code: 0, message: 'Parsing url error.' }] });
        return;
      }

      const modelInfo = url.pathname.match(/^\/llm\/v1\/models\/([^/]+\/[^/]+)$/);
      if (req.method === 'GET' && modelInfo) {
        const id = decodeURIComponent(modelInfo[1]);
        const priced = { pricing: { prompt: '0.000001', completion: '0.000002' }, max_tokens: 1000 };
        const known = {
          'mock/chat': priced,
          'mock/padded': priced,
          'mock/overloaded': priced,
          'mock/error200': priced,
          'mock/length': priced,
          'mock/filtered': priced,
          'mock/slowbody': priced,
          'mock/hosted': { pricing: null, max_tokens: 4096 },
        };
        if (!known[id]) {
          json(404, {
            error: { message: `Model '${id}' was not found`, type: 'invalid_request_error', code: 'model_not_found' },
          });
          return;
        }
        json(200, { id, object: 'model', top_provider: { max_completion_tokens: known[id].max_tokens }, ...known[id] });
        return;
      }

      if (url.pathname === '/llm/v1/chat/completions') {
        if (!gatewayAuthorized(req.headers)) {
          json(401, {
            error: { message: 'Invalid credentials', type: 'authentication_error', code: 'invalid_api_key' },
          });
          return;
        }
        const data = JSON.parse(body.toString('utf8'));
        state.chats.push({ body: data, headers: req.headers });
        state.chatCounts[data.model] = (state.chatCounts[data.model] ?? 0) + 1;
        const count = state.chatCounts[data.model];
        const user = data.messages.find((message) => message.role === 'user');
        const completion = (content, finish = 'stop', headers = {}) =>
          json(
            200,
            {
              id: `chatcmpl-${state.chats.length}`,
              object: 'chat.completion',
              model: data.model,
              choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
              usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, cost: 0.0000123 },
            },
            headers,
          );

        switch (data.model) {
          case 'mock/chat': {
            const headers = 'temperature' in data ? { 'x-wiro-dropped-parameters': 'temperature' } : {};
            completion(`  Echo: ${describeContent(user?.content)}  `, 'stop', headers);
            return;
          }
          case 'mock/padded': {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.write('\n');
            setTimeout(() => {
              res.end(
                '\n' +
                  JSON.stringify({
                    id: 'chatcmpl-padded',
                    object: 'chat.completion',
                    choices: [
                      { index: 0, message: { role: 'assistant', content: 'Late but fine.' }, finish_reason: 'stop' },
                    ],
                    usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4, cost: 0.000001 },
                  }),
              );
            }, 50);
            return;
          }
          case 'mock/overloaded':
            if (count === 1) {
              json(
                503,
                { error: { message: 'The provider is overloaded', type: 'api_error', code: 'provider_overloaded' } },
                { 'retry-after': '0' },
              );
              return;
            }
            completion('Second time lucky.');
            return;
          case 'mock/error200':
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              '\n\n' +
                JSON.stringify({
                  error: {
                    message: 'The model failed to answer',
                    type: 'server_error',
                    code: 'model_execution_failed',
                  },
                }),
            );
            return;
          case 'mock/length':
            completion('A long answer that got', 'length');
            return;
          case 'mock/slowbody':
            // Headers and a keep-alive newline now, the body only after the client gave up.
            res.writeHead(200, { 'content-type': 'application/json' });
            res.write('\n');
            setTimeout(() => res.end('{}'), 2_500);
            return;
          case 'mock/filtered':
            completion('', 'content_filter');
            return;
          default:
            json(404, {
              error: {
                message: `Model '${data.model}' was not found`,
                type: 'invalid_request_error',
                code: 'model_not_found',
              },
            });
            return;
        }
      }

      res.writeHead(404);
      res.end();
    } catch (err) {
      json(500, { result: false, errors: [{ code: 0, message: `Mock error: ${err.message}` }] });
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  const origin = `http://${host}:${address.port}`;
  return {
    origin,
    apiUrl: `${origin}/v1`,
    llmUrl: `${origin}/llm/v1`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const index = process.argv.indexOf('--port');
  const port = index > -1 ? Number(process.argv[index + 1]) : 8787;
  const mock = await startMockServer({ port });
  console.log(`Mock Wiro AI API listening on ${mock.origin}`);
}
