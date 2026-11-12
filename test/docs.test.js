// Checks the YAML examples in the README and the agent skill against action.yml: every
// `with:` key is an input, each mode gets what it needs, and every output a later step reads
// exists.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse, parseDocument } from 'yaml';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

const action = parse(read('action.yml'));
const INPUTS = new Set(Object.keys(action.inputs));
const OUTPUTS = new Set(Object.keys(action.outputs));
const SKILL = 'skills/wiro-github-action/SKILL.md';
const INSTALL = 'npx skills add wiroai/Wiro-Action --skill wiro-github-action';

/** The ```yaml blocks of a Markdown file. */
function yamlBlocks(markdown) {
  return [...markdown.matchAll(/^```yaml\n([\s\S]*?)^```$/gm)].map((match) => match[1]);
}

/** The steps of a workflow file, or of a snippet that is a list of steps. */
function stepsOf(doc) {
  if (Array.isArray(doc)) return doc;
  return Object.values(doc?.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

/** A `with:` value with its `${{ }}` expressions replaced, so it parses as plain YAML. */
function withoutExpressions(value) {
  return String(value).replace(/\$\{\{[\s\S]*?\}\}/g, 'expression');
}

function checkWiroStep(step, where) {
  assert.equal(step.uses, 'wiroai/Wiro-Action@v1', `${where}: uses`);
  const inputs = step.with ?? {};
  for (const key of Object.keys(inputs)) {
    assert.ok(INPUTS.has(key), `${where}: "${key}" is not an input in action.yml`);
  }
  assert.match(String(inputs['api-key']), /^\$\{\{ secrets\.[A-Z_]+ \}\}$/, `${where}: api-key comes from a secret`);

  const mode = inputs.mode ?? (inputs.workflow ? 'workflow' : 'model');
  assert.ok(['model', 'workflow', 'llm'].includes(mode), `${where}: mode "${mode}"`);
  if (mode === 'workflow') assert.ok(inputs.workflow, `${where}: workflow mode needs workflow`);
  else assert.ok(inputs.model, `${where}: ${mode} mode needs model`);
  if (mode === 'llm') assert.ok(inputs.prompt, `${where}: llm mode needs prompt`);

  if (inputs.params !== undefined) {
    const params = parse(withoutExpressions(inputs.params));
    assert.ok(params && typeof params === 'object' && !Array.isArray(params), `${where}: params is a mapping`);
  }
  if (inputs.files !== undefined && mode !== 'llm') {
    const files = parse(withoutExpressions(inputs.files));
    assert.ok(files && typeof files === 'object' && !Array.isArray(files), `${where}: files is a mapping`);
  }
  if (inputs['max-cost'] !== undefined) {
    assert.ok(Number(inputs['max-cost']) > 0, `${where}: max-cost is a positive number`);
  }
}

function checkBlock(block, where) {
  const doc = parseDocument(block);
  assert.deepEqual(doc.errors, [], `${where}: YAML errors`);
  const steps = stepsOf(doc.toJS());
  const wiroIds = new Set();
  for (const [i, step] of steps.entries()) {
    if (!String(step?.uses ?? '').startsWith('wiroai/')) continue;
    checkWiroStep(step, `${where}, step ${i + 1}`);
    if (step.id) wiroIds.add(step.id);
  }
  const ids = new Set(steps.map((step) => step?.id).filter(Boolean));
  for (const [, id, output] of block.matchAll(/steps\.([\w-]+)\.outputs\.([\w-]+)/g)) {
    assert.ok(ids.has(id), `${where}: no step with id "${id}"`);
    if (wiroIds.has(id)) assert.ok(OUTPUTS.has(output), `${where}: "${output}" is not an output in action.yml`);
  }
  return steps.filter((step) => String(step?.uses ?? '').startsWith('wiroai/')).length;
}

for (const file of ['README.md', SKILL]) {
  describe(`${file} examples`, () => {
    const blocks = yamlBlocks(read(file));

    it('match action.yml', () => {
      assert.ok(blocks.length > 0);
      let wiroSteps = 0;
      for (const [i, block] of blocks.entries()) wiroSteps += checkBlock(block, `${file}, YAML block ${i + 1}`);
      assert.ok(wiroSteps >= blocks.length, 'every block has a Wiro AI Action step');
    });
  });
}

describe('agent skill', () => {
  const skill = read(SKILL);

  it('has a name and a description in its frontmatter', () => {
    const match = skill.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(match, 'frontmatter');
    const meta = parse(match[1]);
    assert.equal(meta.name, 'wiro-github-action');
    assert.match(meta.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(typeof meta.description === 'string' && meta.description.length > 0);
    assert.ok(meta.description.length <= 1024, 'description is at most 1024 characters');
  });

  it('is in the README with its install command', () => {
    const readme = read('README.md');
    assert.ok(readme.includes(INSTALL));
    assert.ok(readme.includes(`(./${SKILL})`));
  });
});
