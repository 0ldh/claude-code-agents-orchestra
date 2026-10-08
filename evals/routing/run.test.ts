import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

test('run.ts drives claude in a sandbox per variant and writes a summary', () => {
  const out = mkdtempSync(join(tmpdir(), 'orchestra-eval-test-'));
  try {
    const run = spawnSync(
      process.execPath,
      [
        join(HERE, 'run.ts'),
        '--claude-bin',
        join(HERE, 'fixtures', 'fake-claude.mjs'),
        '--tasks',
        'react-split-component,heap-out-of-memory',
        '--out',
        out,
        '--allow-user-config',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);

    const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
    const hits = Object.fromEntries(summary.records.map((r: any) => [`${r.variant}/${r.taskId}`, r.score.hit]));
    // The fake only routes React work correctly when the index is present.
    assert.deepEqual(hits, {
      'index/react-split-component': true,
      'index/heap-out-of-memory': false,
      'no-index/react-split-component': false,
      'no-index/heap-out-of-memory': false,
    });
    const reactRun = summary.records.find((r: any) => r.variant === 'index' && r.taskId === 'react-split-component');
    // The security-auditor call happens inside a subagent, so it must not be counted.
    assert.deepEqual(reactRun.score.selected, ['tech-lead-orchestrator', 'react-expert']);

    assert.match(readFileSync(join(out, 'summary.md'), 'utf8'), /\| index \| 2 \| 50% \(1\/2\) \|/);
    assert.match(readFileSync(join(out, 'raw', 'index', 'react-split-component.1.jsonl'), 'utf8'), /EXECUTION PLAN/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('run.ts stops before running anything when claude cannot be started', () => {
  const run = spawnSync(
    process.execPath,
    [join(HERE, 'run.ts'), '--claude-bin', join(HERE, 'fixtures', 'missing-claude'), '--tasks', 'vue-pinia', '--allow-user-config'],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Cannot run ".*missing-claude --version"/);
});

test('run.ts refuses tasks that do not exist', () => {
  const run = spawnSync(process.execPath, [join(HERE, 'run.ts'), '--tasks', 'nope', '--dry-run'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Unknown task ids: nope/);
});
