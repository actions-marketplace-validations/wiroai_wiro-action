import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { InputError } from '../src/errors.js';
import { displayPath, downloadOutputs, isTextOutput, mimeType, resolveFiles, safeFileName } from '../src/files.js';
import { PNG, startMockServer } from './mock-server.js';

/** @type {string} */
let workspace;
before(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'wiro-files-'));
  await mkdir(path.join(workspace, 'docs', 'img'), { recursive: true });
  await mkdir(path.join(workspace, 'notes'), { recursive: true });
  for (const file of [
    'README.md',
    'docs/a.md',
    'docs/b.md',
    'docs/img/one.png',
    'docs/img/two.jpg',
    'notes/[draft] café.md',
  ]) {
    await writeFile(path.join(workspace, file), file);
  }
});

const shown = (files) => files.map((file) => displayPath(file, workspace));

describe('resolveFiles', () => {
  it('takes plain paths, globs and folders', async () => {
    assert.deepEqual(shown(await resolveFiles(['README.md'], workspace, 'files')), ['README.md']);
    assert.deepEqual(shown(await resolveFiles(['docs/*.md'], workspace, 'files')), ['docs/a.md', 'docs/b.md']);
    assert.deepEqual(shown(await resolveFiles(['docs/img'], workspace, 'files')), [
      'docs/img/one.png',
      'docs/img/two.jpg',
    ]);
    assert.deepEqual(shown(await resolveFiles(['docs/**/*.png', 'README.md'], workspace, 'files')), [
      'README.md',
      'docs/img/one.png',
    ]);
  });

  it('takes a file that exists as it is, even with glob characters in its name', async () => {
    assert.deepEqual(shown(await resolveFiles(['notes/[draft] café.md'], workspace, 'files')), [
      'notes/[draft] café.md',
    ]);
  });

  it('leaves out patterns that start with !', async () => {
    assert.deepEqual(shown(await resolveFiles(['docs/**', '!docs/img/**'], workspace, 'files')), [
      'docs/a.md',
      'docs/b.md',
    ]);
  });

  it('fails on missing files and empty matches', async () => {
    await assert.rejects(resolveFiles(['nope.md'], workspace, 'files'), (err) => {
      assert.ok(err instanceof InputError);
      assert.equal(err.message, 'files: `nope.md` does not exist.');
      return true;
    });
    await assert.rejects(resolveFiles(['docs/*.txt'], workspace, 'files'), /no files match `docs\/\*\.txt`/);
  });
});

describe('names and types', () => {
  it('tells text outputs from media', () => {
    assert.equal(isTextOutput({ name: 'a.txt', contenttype: 'text/plain' }), true);
    assert.equal(isTextOutput({ name: 'captions.srt', contenttype: 'application/octet-stream' }), true);
    assert.equal(isTextOutput({ name: 'data', contenttype: 'application/json' }), true);
    assert.equal(isTextOutput({ name: '0.png', contenttype: 'image/png' }), false);
  });

  it('keeps downloaded names inside the folder', () => {
    assert.equal(safeFileName('../../etc/passwd'), 'passwd');
    assert.equal(safeFileName('..\\..\\evil.png'), 'evil.png');
    assert.equal(safeFileName('a:b?.png'), 'a_b_.png');
    assert.equal(safeFileName('..'), '');
    assert.equal(safeFileName(undefined), '');
  });

  it('knows the common types', () => {
    assert.equal(mimeType('a.PNG'), 'image/png');
    assert.equal(mimeType('clip.mp4'), 'video/mp4');
    assert.equal(mimeType('x.unknown'), 'application/octet-stream');
  });

  it('shows paths relative to the workspace', () => {
    assert.equal(displayPath(path.join(workspace, 'docs', 'a.md'), workspace), 'docs/a.md');
    assert.equal(displayPath('/elsewhere/a.md', workspace), '/elsewhere/a.md');
  });
});

describe('downloadOutputs', () => {
  /** @type {Awaited<ReturnType<typeof startMockServer>>} */
  let mock;
  before(async () => {
    mock = await startMockServer();
  });
  after(() => mock.close());

  it('saves every output with a URL under a unique name', async () => {
    const dir = path.join(workspace, 'out');
    const saved = await downloadOutputs(
      [
        { name: '0.png', url: `${mock.origin}/files/0.png` },
        { name: '0.png', url: `${mock.origin}/files/1.png` },
        { contenttype: 'raw', content: {} },
        { name: '../escape.png', url: `${mock.origin}/files/2.png` },
        { url: `${mock.origin}/files/from-url.png` },
      ],
      dir,
    );
    assert.deepEqual(
      saved.map((file) => path.relative(dir, file)),
      ['0.png', '0-1.png', 'escape.png', 'from-url.png'],
    );
    assert.deepEqual((await readdir(dir)).sort(), ['0-1.png', '0.png', 'escape.png', 'from-url.png']);
    assert.deepEqual(await readFile(saved[0]), PNG);
  });

  it('never replaces files from an earlier step', async () => {
    const dir = path.join(workspace, 'shared');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '0.png'), 'from step one');
    const saved = await downloadOutputs([{ name: '0.png', url: `${mock.origin}/files/0.png` }], dir);
    assert.deepEqual(
      saved.map((file) => path.relative(dir, file)),
      ['0-1.png'],
    );
    assert.equal(await readFile(path.join(dir, '0.png'), 'utf8'), 'from step one');
  });

  it('gives up after three tries', async () => {
    const dir = path.join(workspace, 'broken');
    await assert.rejects(
      downloadOutputs([{ name: 'x.png', url: `${mock.origin}/missing` }], dir, { retryDelayMs: 1 }),
      /Could not download .*\/missing: HTTP 404/,
    );
    assert.deepEqual(await readdir(dir), []);
  });
});
