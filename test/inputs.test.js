import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import YAML from 'yaml';
import { bearerToken, nextNonce, runApiHeaders, sign } from '../src/auth.js';
import { InputError } from '../src/errors.js';
import {
  DEFAULTS,
  parseBaseUrl,
  parseBoolean,
  parseFileMapping,
  parseList,
  parseMapping,
  parseMaxCost,
  parseMode,
  parseModel,
  parseSeconds,
} from '../src/inputs.js';
import { VERSION } from '../src/version.js';

const root = new URL('../', import.meta.url);

describe('parseModel', () => {
  it('splits owner and project', () => {
    assert.deepEqual(parseModel(' pruna/p-image ', 'model'), {
      id: 'pruna/p-image',
      owner: 'pruna',
      project: 'p-image',
    });
    assert.deepEqual(parseModel('black-forest-labs/flux-2-klein-4b', 'model').owner, 'black-forest-labs');
  });

  it('rejects other shapes with an example for the mode', () => {
    assert.throws(() => parseModel('p-image', 'model'), /like `pruna\/p-image`, not `p-image`/);
    assert.throws(() => parseModel('a/b/c', 'llm'), /like `openai\/gpt-5-4-mini`/);
    assert.throws(() => parseModel('', 'model'), InputError);
    assert.throws(() => parseModel('owner/model name', 'model'), InputError);
  });
});

describe('parseMode', () => {
  it('accepts the three modes, in any case', () => {
    assert.equal(parseMode('LLM'), 'llm');
    assert.equal(parseMode('workflow'), 'workflow');
    assert.equal(parseMode(' model '), 'model');
    assert.throws(() => parseMode('chat'), /`model`, `llm` or `workflow`, not `chat`/);
  });

  it('picks workflow mode when only a workflow is given', () => {
    assert.equal(parseMode(''), 'model');
    assert.equal(parseMode('', { workflow: 'product-ad-a1B2c' }), 'workflow');
    assert.equal(parseMode('model', { workflow: 'product-ad-a1B2c' }), 'model');
  });
});

describe('parseMaxCost', () => {
  it('reads an amount in USD', () => {
    assert.equal(parseMaxCost(''), undefined);
    assert.equal(parseMaxCost('0.50'), 0.5);
    assert.equal(parseMaxCost('$2'), 2);
    assert.equal(parseMaxCost('0'), 0);
    assert.throws(() => parseMaxCost('cheap'), /`max-cost` must be an amount in USD/);
    assert.throws(() => parseMaxCost('-1'), /`max-cost` must be an amount in USD/);
  });
});

describe('parseMapping', () => {
  it('reads JSON and YAML', () => {
    assert.deepEqual(parseMapping('{"width": 1024, "style": "photo"}', 'params'), { width: 1024, style: 'photo' });
    assert.deepEqual(parseMapping('aspectRatio: "16:9"\nseed: 42\nwebSearch: "false"', 'params'), {
      aspectRatio: '16:9',
      seed: 42,
      webSearch: 'false',
    });
  });

  it('keeps YAML 1.2 strings as strings', () => {
    assert.deepEqual(parseMapping('answer: yes\nratio: 16:9', 'params'), { answer: 'yes', ratio: '16:9' });
  });

  it('treats empty input as no parameters', () => {
    assert.deepEqual(parseMapping('', 'params'), {});
    assert.deepEqual(parseMapping('   \n', 'params'), {});
    assert.deepEqual(parseMapping('null', 'params'), {});
  });

  it('rejects lists, scalars and broken input', () => {
    assert.throws(() => parseMapping('[1, 2]', 'params'), /must be a mapping/);
    assert.throws(() => parseMapping('just text', 'params'), /must be a mapping/);
    assert.throws(
      () => parseMapping('a: [', 'params'),
      (err) => {
        assert.ok(err instanceof InputError);
        assert.match(err.message, /^`params` is not valid JSON or YAML: /);
        assert.doesNotMatch(err.message, /:$/);
        return true;
      },
    );
  });
});

describe('parseList', () => {
  it('reads one path per line, YAML list items and JSON arrays', () => {
    assert.deepEqual(parseList('a.md\n\n  docs/*.png  \n# comment\n', 'files'), ['a.md', 'docs/*.png']);
    assert.deepEqual(parseList('- a.md\n- "b c.md"', 'files'), ['a.md', 'b c.md']);
    assert.deepEqual(parseList('["a.md", " b.md "]', 'files'), ['a.md', 'b.md']);
    assert.deepEqual(parseList('', 'files'), []);
  });

  it('rejects a JSON array of other things', () => {
    assert.throws(() => parseList('[1, 2]', 'files'), /list of paths/);
  });
});

describe('parseFileMapping', () => {
  it('takes one path or a list per parameter', () => {
    assert.deepEqual(parseFileMapping('inputImage: a.png\ninputDocumentMultiple:\n  - a.pdf\n  - b.pdf'), {
      inputImage: ['a.png'],
      inputDocumentMultiple: ['a.pdf', 'b.pdf'],
    });
    assert.deepEqual(parseFileMapping(''), {});
  });

  it('rejects values that are not paths', () => {
    assert.throws(() => parseFileMapping('inputImage: 3'), /`inputImage` must be a path/);
    assert.throws(() => parseFileMapping('inputImage: []'), /`inputImage` must be a path/);
    assert.throws(() => parseFileMapping('- a.png'), /must be a mapping/);
  });
});

describe('parseBoolean, parseSeconds and parseBaseUrl', () => {
  it('parse YAML booleans', () => {
    assert.equal(parseBoolean('', 'download', false), false);
    assert.equal(parseBoolean('True', 'download', false), true);
    assert.equal(parseBoolean('false', 'download', true), false);
    assert.throws(() => parseBoolean('yes', 'download', false), /`download` must be `true` or `false`/);
  });

  it('parse seconds', () => {
    assert.equal(parseSeconds('', 'timeout', 600), 600);
    assert.equal(parseSeconds('90', 'timeout', 600), 90);
    assert.equal(parseSeconds('1.5', 'poll-interval', 3), 1.5);
    assert.throws(() => parseSeconds('0', 'timeout', 600), /at least 1/);
    assert.throws(() => parseSeconds('ten', 'timeout', 600), /number of seconds/);
  });

  it('parse base URLs', () => {
    assert.equal(parseBaseUrl('', 'api-url', 'https://api.wiro.ai/v1'), 'https://api.wiro.ai/v1');
    assert.equal(parseBaseUrl('http://127.0.0.1:8787/v1/', 'api-url', ''), 'http://127.0.0.1:8787/v1');
    assert.throws(() => parseBaseUrl('ftp://example.com', 'api-url', ''), /http or https/);
    assert.throws(() => parseBaseUrl('not a url', 'api-url', ''), /must be a URL/);
  });
});

describe('action.yml', () => {
  it('has the same defaults as the code', async () => {
    const action = YAML.parse(await readFile(new URL('action.yml', root), 'utf8'));
    for (const [name, value] of Object.entries(DEFAULTS)) {
      assert.equal(action.inputs[name]?.default, String(value), `default of ${name}`);
    }
  });

  it('runs on Node 24 from dist/index.js and has Marketplace branding', async () => {
    const action = YAML.parse(await readFile(new URL('action.yml', root), 'utf8'));
    assert.equal(action.runs.using, 'node24');
    assert.equal(action.runs.main, 'dist/index.js');
    assert.ok(action.branding.icon && action.branding.color);
    assert.ok(action.description.length <= 125, 'Marketplace descriptions stay short');
  });

  it('has the same version as package.json', async () => {
    const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
    assert.equal(VERSION, pkg.version);
  });
});

describe('auth', () => {
  it('signs as HMAC-SHA256(key = API key, message = secret + nonce)', () => {
    // printf '%s' "my-secret1700000000000" | openssl dgst -sha256 -hmac "my-key"
    assert.equal(
      sign('my-key', 'my-secret', '1700000000000'),
      '2a8e4fb14697fd0eb68d38a6da635fc7613d31068fcf74ade545c01b6b2f1ca5',
    );
  });

  it('never repeats a nonce', () => {
    const first = Number(nextNonce(5));
    const second = Number(nextNonce(5));
    assert.ok(second > first);
  });

  it('sends a signature only with a secret', () => {
    assert.deepEqual(runApiHeaders({ apiKey: 'k' }), { 'x-api-key': 'k' });
    const headers = runApiHeaders({ apiKey: 'k', apiSecret: 's' });
    assert.equal(headers['x-api-key'], 'k');
    assert.equal(headers['x-signature'], sign('k', 's', headers['x-nonce']));
  });

  it('builds the gateway Bearer credential', () => {
    assert.equal(bearerToken({ apiKey: 'k' }), 'Bearer k');
    assert.equal(bearerToken({ apiKey: 'k', apiSecret: 's' }), 'Bearer k:s');
  });
});
