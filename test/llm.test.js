import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { InputError, LlmError } from '../src/errors.js';
import { buildChatRequest, buildUserContent, runChat } from '../src/llm.js';
import { captureLog } from './helpers.js';
import { API_KEY, API_SECRET, PNG, startMockServer } from './mock-server.js';

/** @type {Awaited<ReturnType<typeof startMockServer>>} */
let mock;
/** @type {string} */
let workspace;
before(async () => {
  mock = await startMockServer();
  workspace = await mkdtemp(path.join(tmpdir(), 'wiro-llm-'));
  await writeFile(path.join(workspace, 'notes.md'), '# Notes\nShip it.');
  await writeFile(path.join(workspace, 'logo.png'), PNG);
  await writeFile(path.join(workspace, 'spec.pdf'), '%PDF-1.4 tiny');
  await writeFile(path.join(workspace, 'blob.bin'), Buffer.from([1, 0, 2, 3]));
});
after(() => mock.close());

const file = (name) => path.join(workspace, name);

function chat(model, options = {}) {
  const log = options.log ?? captureLog();
  return runChat({
    llmUrl: mock.llmUrl,
    apiKey: API_KEY,
    apiSecret: options.apiSecret,
    body: { model, messages: [{ role: 'user', content: 'Hello' }], stream: false, ...options.extra },
    timeoutMs: options.timeoutMs ?? 10_000,
    log,
    retryDelayMs: 5,
  });
}

describe('buildUserContent', () => {
  it('sends the prompt alone without files', async () => {
    assert.equal(await buildUserContent('Hi', [], workspace), 'Hi');
  });

  it('puts files first, then the prompt', async () => {
    const parts = await buildUserContent(
      'Describe these.',
      [file('notes.md'), file('logo.png'), file('spec.pdf')],
      workspace,
    );
    assert.deepEqual(
      parts.map((part) => part.type),
      ['text', 'text', 'image_url', 'text', 'file', 'text'],
    );
    assert.equal(parts[0].text, '<file path="notes.md">\n# Notes\nShip it.\n</file>');
    assert.equal(parts[1].text, 'Image: logo.png');
    assert.equal(parts[2].image_url.url, `data:image/png;base64,${PNG.toString('base64')}`);
    assert.equal(parts[3].text, 'Document: spec.pdf');
    assert.equal(parts[4].file.filename, 'spec.pdf');
    assert.match(parts[4].file.file_data, /^data:application\/pdf;base64,/);
    assert.equal(parts[5].text, 'Describe these.');
  });

  it('refuses other binary files', async () => {
    await assert.rejects(buildUserContent('x', [file('blob.bin')], workspace), (err) => {
      assert.ok(err instanceof InputError);
      assert.match(err.message, /blob\.bin is a binary file/);
      return true;
    });
  });
});

describe('buildChatRequest', () => {
  it('adds the system prompt and extra fields', async () => {
    const body = await buildChatRequest({
      model: 'openai/gpt-5-4-mini',
      prompt: 'Hi',
      system: 'Be brief.',
      extra: { max_tokens: 100, reasoning_effort: 'low' },
      workspace,
    });
    assert.deepEqual(body, {
      max_tokens: 100,
      reasoning_effort: 'low',
      model: 'openai/gpt-5-4-mini',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hi' },
      ],
      stream: false,
    });
  });

  it('refuses fields the action sets', async () => {
    for (const field of ['model', 'messages', 'stream']) {
      await assert.rejects(
        buildChatRequest({ model: 'a/b', prompt: 'x', extra: { [field]: 1 }, workspace }),
        new RegExp(`can't set \`${field}\``),
      );
    }
  });
});

describe('runChat', () => {
  it('returns the trimmed answer and the cost', async () => {
    const result = await chat('mock/chat');
    assert.equal(result.text, 'Echo: Hello');
    assert.equal(result.cost, '0.0000123');
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.usage.prompt_tokens, 12);
    assert.equal(result.response.object, 'chat.completion');
    const sent = mock.state.chats.at(-1);
    assert.equal(sent.headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(sent.body.stream, false);
  });

  it('sends key:secret for signature projects', async () => {
    await chat('mock/chat', { apiSecret: API_SECRET });
    assert.equal(mock.state.chats.at(-1).headers.authorization, `Bearer ${API_KEY}:${API_SECRET}`);
  });

  it('reports fields the gateway left out', async () => {
    const log = captureLog();
    await chat('mock/chat', { log, extra: { temperature: 0.2 } });
    assert.deepEqual(log.lines.warning, ['The gateway left out fields that mock/chat does not use: temperature']);
  });

  it('reads a body that comes after keep-alive newlines', async () => {
    const result = await chat('mock/padded');
    assert.equal(result.text, 'Late but fine.');
  });

  it('tries again when the provider is busy', async () => {
    const log = captureLog();
    const result = await chat('mock/overloaded', { log });
    assert.equal(result.text, 'Second time lucky.');
    assert.equal(mock.state.chatCounts['mock/overloaded'], 2);
    assert.match(log.lines.info[0], /busy \(The provider is overloaded\)\. Trying again/);
  });

  it('fails on an error inside a 200 body', async () => {
    await assert.rejects(chat('mock/error200'), (err) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.code, 'model_execution_failed');
      assert.equal(err.message, 'The LLM gateway answered: The model failed to answer (model_execution_failed)');
      return true;
    });
  });

  it('warns when the answer hit the token limit', async () => {
    const log = captureLog();
    const result = await chat('mock/length', { log });
    assert.equal(result.finishReason, 'length');
    assert.match(log.lines.warning[0], /token limit/);
  });

  it('fails when the content filter stopped the answer', async () => {
    await assert.rejects(chat('mock/filtered'), /content filter/);
  });

  it('times out with a clear message while the body is still coming', async () => {
    await assert.rejects(chat('mock/slowbody', { timeoutMs: 1_000 }), (err) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.message, 'No answer from the LLM gateway within 1 s.');
      return true;
    });
  });

  it('explains unknown models and rejected keys', async () => {
    await assert.rejects(chat('mock/nothing'), /Model 'mock\/nothing' was not found \(model_not_found\)/);
    await assert.rejects(
      runChat({
        llmUrl: mock.llmUrl,
        apiKey: 'wrong',
        body: { model: 'mock/chat', messages: [] },
        timeoutMs: 5_000,
        log: captureLog(),
      }),
      /Invalid credentials \(invalid_api_key\)\. Check `api-key`/,
    );
  });

  it('refuses requests over 16 MiB before sending them', async () => {
    const chats = mock.state.chats.length;
    await assert.rejects(
      chat('mock/chat', { extra: { padding: 'x'.repeat(17 * 1024 * 1024) } }),
      /takes up to 16 MiB per request/,
    );
    assert.equal(mock.state.chats.length, chats);
  });
});
