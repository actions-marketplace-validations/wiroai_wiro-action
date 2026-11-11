// Runs the bundled action (dist/index.js) the way the runner does: inputs in INPUT_*
// variables, outputs read back from the GITHUB_OUTPUT file. Run `npm run build` first.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { API_KEY, PNG, startMockServer } from './mock-server.js';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

/** @type {Awaited<ReturnType<typeof startMockServer>>} */
let mock;
before(async () => {
  mock = await startMockServer();
});
after(() => mock.close());

/** Reads `name<<delimiter` blocks from a GITHUB_OUTPUT file. */
function parseOutputs(text) {
  const outputs = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^([^<]+)<<(.+)$/);
    if (!match) continue;
    const [, name, delimiter] = match;
    const value = [];
    for (i++; i < lines.length && lines[i] !== delimiter; i++) value.push(lines[i]);
    outputs[name] = value.join('\n');
  }
  return outputs;
}

/**
 * @param {Record<string, string>} inputs
 * @param {{ onStdout?: (text: string, child: import('node:child_process').ChildProcess) => void, killAfterMs?: number }} [options]
 */
async function runAction(inputs, { onStdout, killAfterMs } = {}) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'wiro-action-'));
  await writeFile(path.join(workspace, 'notes.md'), 'Release notes: faster uploads.');
  await writeFile(path.join(workspace, 'logo.png'), PNG);
  const outputFile = path.join(workspace, '.output');
  const summaryFile = path.join(workspace, '.summary');
  await writeFile(outputFile, '');
  await writeFile(summaryFile, '');

  const env = {
    PATH: process.env.PATH,
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    'INPUT_API-KEY': API_KEY,
    'INPUT_API-URL': mock.apiUrl,
    'INPUT_LLM-URL': mock.llmUrl,
    'INPUT_POLL-INTERVAL': '1',
  };
  for (const [name, value] of Object.entries(inputs)) env[`INPUT_${name.toUpperCase()}`] = value;

  const child = spawn(process.execPath, [entry], { cwd: workspace, env });
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    onStdout?.(stdout, child);
  });
  child.stderr.on('data', (chunk) => (stdout += chunk));
  if (killAfterMs) setTimeout(() => child.kill('SIGTERM'), killAfterMs);
  const code = await new Promise((resolve) => child.on('close', resolve));
  return {
    code,
    stdout,
    workspace,
    outputs: parseOutputs(await readFile(outputFile, 'utf8')),
    summary: await readFile(summaryFile, 'utf8'),
  };
}

describe('dist/index.js', () => {
  it('runs a model, downloads its files and sets the outputs', async () => {
    const { code, stdout, outputs, summary, workspace } = await runAction({
      model: 'mock/image',
      prompt: 'A paper boat',
      params: 'aspectRatio: "16:9"',
      download: 'true',
      'download-dir': 'art',
    });
    assert.equal(code, 0, stdout);
    assert.match(outputs['task-id'], /^\d+$/);
    assert.equal(JSON.parse(outputs.urls).length, 2);
    assert.equal(outputs.url, JSON.parse(outputs.urls)[0]);
    assert.deepEqual(JSON.parse(outputs.files), ['art/0.png', 'art/0-1.png']);
    assert.equal(outputs.cost, '0.005');
    assert.equal(outputs.text, '');
    assert.equal(JSON.parse(outputs.outputs)[0].name, '0.png');
    assert.ok((await stat(path.join(workspace, 'art', '0-1.png'))).size > 0);
    assert.deepEqual(mock.state.runs.at(-1).body, { aspectRatio: '16:9', prompt: 'A paper boat' });
    assert.match(stdout, /::add-mask::test-key/);
    assert.match(summary, /### Wiro AI: mock\/image/);
    assert.match(summary, /<img src="http:\/\/127\.0\.0\.1:\d+\/files\/0\.png"/);
  });

  it('asks an LLM with files and sets the text output', async () => {
    const { code, stdout, outputs, summary } = await runAction({
      mode: 'llm',
      model: 'mock/chat',
      system: 'Be brief.',
      prompt: 'Summarize the notes.',
      files: 'notes.md\nlogo.png',
    });
    assert.equal(code, 0, stdout);
    assert.equal(outputs.text, 'Echo: 3 text, 1 image_url');
    assert.equal(outputs.cost, '0.0000123');
    assert.equal(JSON.parse(outputs.response).choices[0].finish_reason, 'stop');
    const sent = mock.state.chats.at(-1).body;
    assert.deepEqual(sent.messages[0], { role: 'system', content: 'Be brief.' });
    assert.match(summary, /Echo: 3 text, 1 image_url/);
  });

  it('fails the step when the run fails', async () => {
    const { code, stdout, outputs } = await runAction({ model: 'mock/fail', prompt: 'x' });
    assert.equal(code, 1);
    assert.match(
      stdout,
      /::error::The model run failed \(task \d+, exit code 1\): The input image could not be read\./,
    );
    assert.match(outputs['task-id'], /^\d+$/, 'the task ID is set before the failure');
  });

  it('fails on bad inputs before calling the API', async () => {
    const runs = mock.state.runs.length;
    const { code, stdout } = await runAction({ model: 'mock/image', prompt: 'x', params: 'prompt: y' });
    assert.equal(code, 1);
    assert.match(stdout, /::error::The prompt is set in both `prompt` and `params`/);
    assert.equal(mock.state.runs.length, runs);
  });

  it('stops the task when the workflow run is cancelled', async () => {
    const kills = mock.state.kills.length;
    let sent = false;
    const { code, stdout } = await runAction(
      { model: 'mock/slow', prompt: 'x', timeout: '60' },
      {
        onStdout: (text, child) => {
          if (!sent && text.includes('Status: task_start')) {
            sent = true;
            child.kill('SIGTERM');
          }
        },
      },
    );
    assert.equal(code, 1, stdout);
    assert.match(stdout, /Received SIGTERM, stopping task \d+/);
    assert.equal(mock.state.kills.length, kills + 1);
  });

  it('stops the task when the run is cancelled while the Run request is open', async () => {
    const stops = mock.state.kills.length + mock.state.cancels.length;
    const { code, stdout } = await runAction({ model: 'mock/slowstart', prompt: 'x' }, { killAfterMs: 400 });
    assert.equal(code, 1, stdout);
    assert.match(stdout, /Received SIGTERM while the run was starting/);
    assert.match(stdout, /Stopped task \d+ with Task\/Cancel\./);
    assert.equal(mock.state.kills.length + mock.state.cancels.length, stops + 1);
  });

  it('prints answers with workflow commands turned off', async () => {
    const { code, stdout, outputs } = await runAction({
      mode: 'llm',
      model: 'mock/chat',
      prompt: 'Hi\n::warning::not a real warning',
    });
    assert.equal(code, 0, stdout);
    assert.equal(outputs.text, 'Echo: Hi\n::warning::not a real warning');
    assert.match(stdout, /::stop-commands::([0-9a-f-]{36})\nEcho: Hi\n::warning::not a real warning\n::\1::/);
  });

  it('explains an empty api-key', async () => {
    const { code, stdout } = await runAction({ 'api-key': '', model: 'mock/image', prompt: 'x' });
    assert.equal(code, 1);
    assert.match(stdout, /::error::`api-key` is empty\. Pass it from a secret/);
    assert.match(stdout, /from forks, or by Dependabot, don't receive repository secrets/);
  });
});
