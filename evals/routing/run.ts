import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadCatalog, parseStream, score, summarize, validateTasks, VARIANTS } from './lib.ts';
import type { RunRecord, Task, Variant } from './lib.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
// The framework stops at its approval gate, so nothing should be written. Denying these keeps it that way.
const DENIED_TOOLS = 'Bash,Edit,Write,NotebookEdit';

const { values: opts } = parseArgs({
  options: {
    variants: { type: 'string', default: VARIANTS.map((v) => v.name).join(',') },
    tasks: { type: 'string' },
    repeat: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '2' },
    model: { type: 'string' },
    'max-turns': { type: 'string', default: '15' },
    timeout: { type: 'string', default: '600' },
    'claude-bin': { type: 'string', default: 'claude' },
    out: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'allow-user-config': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (opts.help) {
  console.log(`Usage: node run.ts [options]

  --variants <a,b>        Variants to compare (default: ${VARIANTS.map((v) => v.name).join(',')})
  --tasks <id,id>         Run only these task ids (default: all in tasks.json)
  --repeat <n>            Runs per task and variant (default: 1)
  --concurrency <n>       Parallel claude processes (default: 2)
  --model <model>         Passed to claude --model
  --max-turns <n>         Passed to claude --max-turns (default: 15)
  --timeout <seconds>     Kill a run after this long (default: 600)
  --claude-bin <path>     Claude Code executable (default: claude)
  --out <dir>             Results directory (default: results/<timestamp>)
  --dry-run               Build one sandbox per variant and print the plan; do not call claude
  --allow-user-config     Run even if ~/.claude/CLAUDE.md or ~/.claude/agents exist`);
  process.exit(0);
}

function positiveInt(name: string, raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer, got "${raw}"`);
  return n;
}

const repeat = positiveInt('repeat', opts.repeat);
const concurrency = positiveInt('concurrency', opts.concurrency);
const maxTurns = positiveInt('max-turns', opts['max-turns']);
const timeoutMs = positiveInt('timeout', opts.timeout) * 1000;

const catalog = loadCatalog(join(REPO, 'agents'));
const agentNames = catalog.map((a) => a.name);
const claudeMd = readFileSync(join(REPO, 'CLAUDE.md.example'), 'utf8');

const allTasks: Task[] = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8'));
const problems = validateTasks(allTasks, agentNames);
if (problems.length > 0) {
  console.error(`tasks.json is out of date with agents/:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

const wantedTasks = opts.tasks?.split(',').map((s) => s.trim());
const tasks = wantedTasks ? allTasks.filter((t) => wantedTasks.includes(t.id)) : allTasks;
const unknownTasks = wantedTasks?.filter((id) => !allTasks.some((t) => t.id === id)) ?? [];
if (unknownTasks.length > 0) {
  console.error(`Unknown task ids: ${unknownTasks.join(', ')}`);
  process.exit(1);
}

const variants: Variant[] = (opts.variants ?? '').split(',').map((name) => {
  const variant = VARIANTS.find((v) => v.name === name.trim());
  if (!variant) {
    console.error(`Unknown variant "${name}". Known: ${VARIANTS.map((v) => v.name).join(', ')}`);
    process.exit(1);
  }
  return variant;
});

// Claude Code also loads the user's own memory and agents. If the framework is installed there,
// the no-index variant would still see the index, and the comparison would be meaningless.
const userClaudeDir = join(homedir(), '.claude');
const userConfig = [
  existsSync(join(userClaudeDir, 'CLAUDE.md')) ? '~/.claude/CLAUDE.md' : null,
  existsSync(join(userClaudeDir, 'agents')) && readdirSync(join(userClaudeDir, 'agents')).some((f) => f.endsWith('.md'))
    ? '~/.claude/agents/*.md'
    : null,
].filter((p): p is string => p !== null);
if (userConfig.length > 0 && !opts['allow-user-config'] && !opts['dry-run']) {
  console.error(
    `Found ${userConfig.join(' and ')}. Claude Code loads these into every run, which mixes your own setup into the results.\n` +
      'Move them aside while the eval runs, or pass --allow-user-config if you know they do not affect routing.',
  );
  process.exit(1);
}

/** A throwaway project: the variant's CLAUDE.md, the agents as subagents, and the agents/ tree the index points to. */
function makeSandbox(variant: Variant): string {
  const dir = mkdtempSync(join(tmpdir(), `orchestra-eval-${variant.name}-`));
  writeFileSync(join(dir, 'CLAUDE.md'), variant.transform(claudeMd));
  cpSync(join(REPO, 'agents'), join(dir, 'agents'), { recursive: true });
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  for (const agent of catalog) {
    copyFileSync(join(REPO, 'agents', agent.path), join(dir, '.claude', 'agents', basename(agent.path)));
  }
  return dir;
}

function claudeArgs(): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--max-turns', String(maxTurns)];
  if (opts.model) args.push('--model', opts.model);
  args.push('--disallowedTools', DENIED_TOOLS);
  return args;
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = resolve(opts.out ?? join(HERE, 'results', stamp));

if (opts['dry-run']) {
  console.log(`claude command (prompt on stdin): ${opts['claude-bin']} ${claudeArgs().join(' ')}`);
  console.log(`${tasks.length} tasks × ${variants.length} variants × ${repeat} = ${tasks.length * variants.length * repeat} runs`);
  for (const variant of variants) console.log(`sandbox for ${variant.name}: ${makeSandbox(variant)}`);
  if (userConfig.length > 0) console.log(`warning: ${userConfig.join(' and ')} would be loaded into every run`);
  process.exit(0);
}

// A missing or broken binary would otherwise show up as a 0% hit rate.
const probe = spawnSync(opts['claude-bin'] ?? 'claude', ['--version'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
  console.error(`Cannot run "${opts['claude-bin']} --version": ${probe.error?.message ?? probe.stderr.trim()}`);
  process.exit(1);
}

function runClaude(prompt: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((done) => {
    const child = spawn(opts['claude-bin'] ?? 'claude', claudeArgs(), { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      stderr += `\n[eval] killed after ${timeoutMs / 1000}s`;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => {
      stderr += `\n[eval] ${error.message}`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ stdout, stderr, code });
    });
    child.stdin.end(prompt);
  });
}

const jobs = variants.flatMap((variant) =>
  tasks.flatMap((task) => Array.from({ length: repeat }, (_, i) => ({ variant, task, attempt: i + 1 }))),
);
const total = jobs.length;
const records: RunRecord[] = [];
let finished = 0;

async function worker(): Promise<void> {
  for (let job = jobs.shift(); job; job = jobs.shift()) {
    const { variant, task, attempt } = job;
    const sandbox = makeSandbox(variant);
    try {
      const { stdout, stderr, code } = await runClaude(task.prompt, sandbox);
      const rawDir = join(outDir, 'raw', variant.name);
      mkdirSync(rawDir, { recursive: true });
      writeFileSync(join(rawDir, `${task.id}.${attempt}.jsonl`), stdout);
      if (stderr.trim()) writeFileSync(join(rawDir, `${task.id}.${attempt}.stderr.txt`), stderr);

      const obs = parseStream(stdout);
      if (obs.status === 'no-result') obs.status = `exit-${code}`;
      const result = score(task, obs, agentNames);
      records.push({ variant: variant.name, taskId: task.id, attempt, obs, score: result });
      finished += 1;
      console.log(
        `[${finished}/${total}] ${variant.name} ${task.id}#${attempt}: ${result.hit ? 'hit ' : 'MISS'} ` +
          `${result.selected.join(', ') || '(no agents)'}${obs.status === 'success' ? '' : ` [${obs.status}]`}`,
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }
}

console.log(`${total} runs → ${outDir}`);
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));

const variantNames = variants.map((v) => v.name);
const summary = summarize(records, tasks, variantNames);
const header = [
  '# Routing eval',
  '',
  `- Date: ${new Date().toISOString()}`,
  `- Model: ${opts.model ?? '(claude default)'}`,
  `- Runs per task and variant: ${repeat}`,
  ...variants.map((v) => `- \`${v.name}\`: ${v.description}`),
  ...(userConfig.length > 0 ? [`- Warning: ${userConfig.join(' and ')} were loaded into every run`] : []),
  '',
].join('\n');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'summary.md'), `${header}\n${summary.markdown}`);
writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify({ overall: summary.overall, records }, null, 2)}\n`);
console.log(`\n${summary.markdown}`);
console.log(`Wrote ${join(outDir, 'summary.md')}`);
