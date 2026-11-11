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
};

/** Tool/Detail parameter lists. */
const TOOL_PARAMETERS = {
  'mock/upload': [
    { id: 'inputImage', type: 'fileinput' },
    { id: 'inputDocumentMultiple', type: 'multifileinput' },
    { id: 'inputImageClothes', type: 'combinefileinput' },
    { id: 'prompt', type: 'textarea' },
    { id: 'scale', type: 'number' },
  ],
};

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
          const id = String(nextTask++);
          const token = `token-${id}`;
          state.tasks.set(token, { id, model, polls: 0, scenario, stopped: false });
          json(200, { result: true, errors: [], taskid: id, socketaccesstoken: token });
          return;
        }

        const data = body.length ? JSON.parse(body.toString('utf8')) : {};
        if (route === '/Task/Detail') {
          state.details += 1;
          const task = state.tasks.get(data.tasktoken);
          if (!task) {
            json(200, { result: false, errors: [{ code: 0, message: 'task-not-founded' }] });
            return;
          }
          task.polls += 1;
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
          const task =
            route === '/Task/Cancel'
              ? [...state.tasks.values()].find((entry) => entry.id === data.taskid)
              : state.tasks.get(data.socketaccesstoken);
          (route === '/Task/Cancel' ? state.cancels : state.kills).push(data.taskid ?? data.socketaccesstoken);
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
          const items = TOOL_PARAMETERS[`${data.slugowner}/${data.slugproject}`];
          if (!items) {
            json(200, { result: false, errors: [{ code: 1, message: 'slug-owner-project-not-exist' }] });
            return;
          }
          json(200, { result: true, errors: [], tool: [{ parameters: [{ title: '', items }] }] });
          return;
        }
        json(404, { result: false, errors: [{ code: 0, message: 'Parsing url error.' }] });
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
