import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadCatalog, parseStream, plannedAgents, score, stripIndex, summarize, validateTasks } from './lib.ts';
import type { RunObservation, RunRecord, Task } from './lib.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const catalog = loadCatalog(join(REPO, 'agents'));
const names = catalog.map((a) => a.name);
const claudeMd = readFileSync(join(REPO, 'CLAUDE.md.example'), 'utf8');
const tasks: Task[] = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8'));

/** "|react,tsx,jsx -> @react-expert" lines from the Trigger Keywords block */
function triggerKeywords(md: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [, words, agent] of md.matchAll(/^\|([^|\n]+?)\s*->\s*@([a-z0-9-]+)\s*$/gm)) {
    map.set(agent, words.split(',').map((w) => w.trim().toLowerCase()));
  }
  return map;
}

function containsWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`, 'iu').test(text);
}

function obs(partial: Partial<RunObservation>): RunObservation {
  return { delegated: [], finalText: '', status: 'success', costUsd: null, turns: null, durationMs: null, ...partial };
}

test('every agent file has a unique frontmatter name that matches its filename', () => {
  assert.ok(catalog.length > 0);
  assert.equal(new Set(names).size, names.length);
  for (const agent of catalog) assert.equal(agent.path.split('/').pop(), `${agent.name}.md`);
});

test('tasks.json only expects agents that exist', () => {
  assert.deepEqual(validateTasks(tasks, names), []);
});

test('validateTasks reports unknown agents and duplicate ids', () => {
  const bad: Task[] = [
    { id: 'a', group: 'direct', prompt: 'x', expected: ['nope'] },
    { id: 'a', group: 'direct', prompt: 'x', expected: ['react-expert'] },
  ];
  assert.deepEqual(validateTasks(bad, names), ['a: "nope" is not an agent in agents/', 'duplicate task id "a"']);
});

test('task groups match the trigger keywords: direct tasks hit one, indirect tasks hit none', () => {
  const keywords = triggerKeywords(claudeMd);
  assert.ok(keywords.size > 0, 'no trigger keywords parsed from CLAUDE.md.example');
  for (const task of tasks) {
    const words = task.expected.flatMap((agent) => keywords.get(agent) ?? []);
    const found = words.filter((w) => containsWord(task.prompt, w));
    if (task.group === 'direct') assert.ok(found.length > 0, `${task.id} is "direct" but names none of: ${words.join(', ')}`);
    if (task.group === 'indirect') assert.deepEqual(found, [], `${task.id} is "indirect" but contains trigger keywords`);
  }
});

test('stripIndex removes the index, retrieval map and keywords but keeps the triage protocol', () => {
  const stripped = stripIndex(claudeMd);
  assert.ok(!stripped.includes('AGENT ORCHESTRA INDEX'));
  assert.ok(!stripped.includes('[AgentPaths]'));
  assert.ok(!stripped.includes('-> @react-expert'));
  assert.ok(stripped.includes('## 1. TRIAGE PROTOCOL'));
  assert.ok(stripped.includes('Triage Officer & Approval Gateway'));
  assert.throws(() => stripIndex('# no markers here'), /no longer has/);
});

test('parseStream keeps main-thread delegations and ignores calls made inside subagents', () => {
  const stream = readFileSync(join(HERE, 'fixtures', 'sample-stream.jsonl'), 'utf8');
  const result = parseStream(stream);
  assert.deepEqual(result.delegated, ['tech-lead-orchestrator', 'react-expert']);
  assert.equal(result.status, 'success');
  assert.equal(result.costUsd, 0.21);
  assert.equal(result.turns, 4);
  assert.match(result.finalText, /EXECUTION PLAN/);
});

test('parseStream falls back to the last main-thread text when there is no result event', () => {
  const lines = [
    JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'first' }] } }),
    'not json',
    JSON.stringify({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'text', text: 'inside subagent' }] } }),
    JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'last' }] } }),
  ];
  const result = parseStream(lines.join('\n'));
  assert.equal(result.finalText, 'last');
  assert.equal(result.status, 'no-result');
});

test('plannedAgents reads bare names inside the Agent List and only @names elsewhere', () => {
  const plan = 'Assigned to: @tech-lead-orchestrator\nAgent List:\n- react-expert: build UI\n- [@test-automator]: tests\n⚠️ AWAITING APPROVAL\nLater: @debugger';
  assert.deepEqual(plannedAgents(plan, names).sort(), ['react-expert', 'tech-lead-orchestrator', 'test-automator']);

  const prose = 'Attach a debugger to the process, then ask @react-expert. Not @react-expert-v2 or email@debugger.';
  assert.deepEqual(plannedAgents(prose, names), ['react-expert']);
});

test('score counts any expected agent as a hit and ignores orchestration agents in extras', () => {
  const task: Task = { id: 't', group: 'direct', prompt: 'p', expected: ['react-expert', 'nextjs-specialist'] };
  const result = score(
    task,
    obs({ delegated: ['tech-lead-orchestrator', 'general-purpose'], finalText: 'Agent List:\n[@nextjs-specialist]\n[@typescript-expert]' }),
    names,
  );
  assert.equal(result.hit, true);
  assert.deepEqual(result.selected, ['tech-lead-orchestrator', 'nextjs-specialist', 'typescript-expert']);
  assert.deepEqual(result.extras, ['typescript-expert']);

  assert.equal(score(task, obs({ finalText: 'Agent List:\n[@typescript-expert]' }), names).hit, false);
});

test('summarize reports hit rates per variant and group', () => {
  const sample: Task[] = [
    { id: 'a', group: 'direct', prompt: 'p', expected: ['react-expert'] },
    { id: 'b', group: 'indirect', prompt: 'p', expected: ['debugger'] },
  ];
  const record = (variant: string, taskId: string, hit: boolean): RunRecord => ({
    variant,
    taskId,
    attempt: 1,
    obs: obs({ costUsd: 0.1, turns: 3 }),
    score: { hit, selected: hit ? ['react-expert'] : [], extras: [] },
  });
  const { overall, markdown } = summarize(
    [record('index', 'a', true), record('index', 'b', true), record('no-index', 'a', true), record('no-index', 'b', false)],
    sample,
    ['index', 'no-index'],
  );
  assert.equal(overall[0].hitRate, '100% (2/2)');
  assert.equal(overall[1].hitRate, '50% (1/2)');
  assert.equal(overall[1].indirect, '0% (0/1)');
  assert.equal(overall[1].ko, '–');
  assert.match(markdown, /\| b \| indirect \| debugger \| 1\/1 · react-expert \| 0\/1 · \(none\) \|/);
});
