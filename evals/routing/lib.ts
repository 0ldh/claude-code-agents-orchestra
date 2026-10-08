import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type TaskGroup = 'direct' | 'indirect' | 'ko';

export interface Task {
  id: string;
  /** direct: names the technology; indirect: describes the symptom only; ko: written in Korean */
  group: TaskGroup;
  prompt: string;
  /** Any one of these agents counts as a correct pick. */
  expected: string[];
}

export interface AgentFile {
  name: string;
  /** Path relative to the agents/ directory, e.g. "design/ui-ux-designer.md" */
  path: string;
}

export interface Variant {
  name: string;
  description: string;
  transform: (claudeMd: string) => string;
}

export interface RunObservation {
  /** subagent_type of every Agent/Task call made by the main thread */
  delegated: string[];
  finalText: string;
  /** subtype of the result event, e.g. "success" or "error_max_turns"; "no-result" if it never arrived */
  status: string;
  costUsd: number | null;
  turns: number | null;
  durationMs: number | null;
}

export interface Score {
  hit: boolean;
  /** Catalog agents that were delegated to or listed in the plan */
  selected: string[];
  /** selected minus expected and orchestration agents */
  extras: string[];
}

export interface RunRecord {
  variant: string;
  taskId: string;
  attempt: number;
  obs: RunObservation;
  score: Score;
}

/** Orchestration agents route work; picking them is never counted as an extra specialist. */
export const ORCHESTRATION_AGENTS = new Set(['tech-lead-orchestrator', 'code-archaeologist', 'context-manager']);

const INDEX_START = '## AGENT ORCHESTRA INDEX';
const INDEX_END = '## 1. TRIAGE PROTOCOL';

export function loadCatalog(agentsDir: string): AgentFile[] {
  const files = readdirSync(agentsDir, { recursive: true, encoding: 'utf8' })
    .filter((p) => p.endsWith('.md'))
    .sort();
  return files.map((path) => {
    const source = readFileSync(join(agentsDir, path), 'utf8');
    const name = source.match(/^---\r?\n[\s\S]*?^name:\s*(\S+)/m)?.[1];
    if (!name) throw new Error(`No "name:" in the frontmatter of agents/${path}`);
    return { name, path: path.split('\\').join('/') };
  });
}

/** Removes the Agent Orchestra Index (team index, retrieval map, trigger keywords) and keeps everything else. */
export function stripIndex(claudeMd: string): string {
  const start = claudeMd.indexOf(INDEX_START);
  const end = claudeMd.indexOf(INDEX_END);
  // Fail loudly: if the headings change, a silent no-op would make both variants identical.
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`CLAUDE.md.example no longer has "${INDEX_START}" followed by "${INDEX_END}"`);
  }
  return claudeMd.slice(0, start) + claudeMd.slice(end);
}

export const VARIANTS: Variant[] = [
  { name: 'index', description: 'CLAUDE.md.example as shipped', transform: (md) => md },
  {
    name: 'no-index',
    description: 'CLAUDE.md.example without the Agent Orchestra Index section',
    transform: stripIndex,
  },
];

export function validateTasks(tasks: Task[], agentNames: string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) problems.push(`duplicate task id "${task.id}"`);
    seen.add(task.id);
    if (!['direct', 'indirect', 'ko'].includes(task.group)) problems.push(`${task.id}: unknown group "${task.group}"`);
    if (!task.prompt.trim()) problems.push(`${task.id}: empty prompt`);
    if (task.expected.length === 0) problems.push(`${task.id}: no expected agents`);
    for (const name of task.expected) {
      if (!agentNames.includes(name)) problems.push(`${task.id}: "${name}" is not an agent in agents/`);
    }
  }
  return problems;
}

/** Reads `claude -p --output-format stream-json --verbose` output. */
export function parseStream(jsonl: string): RunObservation {
  const obs: RunObservation = { delegated: [], finalText: '', status: 'no-result', costUsd: null, turns: null, durationMs: null };
  let lastMainText = '';
  let resultText: string | null = null;

  for (const line of jsonl.split('\n')) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    // Events from inside a subagent carry the id of the tool call that started it.
    const mainThread = event?.parent_tool_use_id == null;
    if (event?.type === 'assistant' && mainThread && Array.isArray(event.message?.content)) {
      const texts: string[] = [];
      for (const block of event.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        if (block?.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task')) {
          const subagent = block.input?.subagent_type;
          if (typeof subagent === 'string') obs.delegated.push(subagent);
        }
      }
      if (texts.length > 0) lastMainText = texts.join('\n');
    }
    if (event?.type === 'result') {
      obs.status = typeof event.subtype === 'string' ? event.subtype : 'unknown';
      if (typeof event.result === 'string') resultText = event.result;
      if (typeof event.total_cost_usd === 'number') obs.costUsd = event.total_cost_usd;
      if (typeof event.num_turns === 'number') obs.turns = event.num_turns;
      if (typeof event.duration_ms === 'number') obs.durationMs = event.duration_ms;
    }
  }
  obs.finalText = resultText ?? lastMainText;
  return obs;
}

function mentions(text: string, name: string, requireAt: boolean): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefix = requireAt ? '@' : '@?';
  return new RegExp(`(?<![\\w@-])${prefix}${escaped}(?![\\w-])`, 'i').test(text);
}

/**
 * Agents named in the EXECUTION PLAN. Inside "Assigned to" and "Agent List" a bare name counts;
 * if the plan format is missing, only @name counts, so prose like "attach a debugger" is ignored.
 */
export function plannedAgents(text: string, agentNames: string[]): string[] {
  const listStart = text.search(/agent list/i);
  if (listStart === -1) return agentNames.filter((name) => mentions(text, name, true));

  const assigned = text.match(/assigned to:[^\n]*/i)?.[0] ?? '';
  const rest = text.slice(listStart);
  const stop = rest.search(/awaiting approval/i);
  const segment = `${assigned}\n${stop === -1 ? rest : rest.slice(0, stop)}`;
  return agentNames.filter((name) => mentions(segment, name, false));
}

export function score(task: Task, obs: RunObservation, agentNames: string[]): Score {
  const delegated = obs.delegated.filter((name) => agentNames.includes(name));
  const selected = [...new Set([...delegated, ...plannedAgents(obs.finalText, agentNames)])];
  return {
    hit: task.expected.some((name) => selected.includes(name)),
    selected,
    extras: selected.filter((name) => !task.expected.includes(name) && !ORCHESTRATION_AGENTS.has(name)),
  };
}

function average(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

function rate(records: RunRecord[]): string {
  if (records.length === 0) return '–';
  const hits = records.filter((r) => r.score.hit).length;
  return `${Math.round((hits / records.length) * 100)}% (${hits}/${records.length})`;
}

function fixed(value: number | null, digits: number): string {
  return value === null ? '–' : value.toFixed(digits);
}

export function summarize(records: RunRecord[], tasks: Task[], variants: string[]) {
  const groupOf = new Map(tasks.map((t) => [t.id, t.group]));
  const overall = variants.map((variant) => {
    const runs = records.filter((r) => r.variant === variant);
    const byGroup = (group: TaskGroup) => runs.filter((r) => groupOf.get(r.taskId) === group);
    return {
      variant,
      runs: runs.length,
      hitRate: rate(runs),
      direct: rate(byGroup('direct')),
      indirect: rate(byGroup('indirect')),
      ko: rate(byGroup('ko')),
      avgExtras: average(runs.map((r) => r.score.extras.length)),
      avgCostUsd: average(runs.flatMap((r) => (r.obs.costUsd === null ? [] : [r.obs.costUsd]))),
      avgTurns: average(runs.flatMap((r) => (r.obs.turns === null ? [] : [r.obs.turns]))),
      notSuccess: runs.filter((r) => r.obs.status !== 'success').length,
    };
  });

  const lines = [
    '## Overall',
    '',
    '| Variant | Runs | Hit rate | direct | indirect | ko | Avg extra specialists | Avg cost (USD, as reported) | Avg turns | Runs not "success" |',
    '| :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: |',
    ...overall.map(
      (o) =>
        `| ${o.variant} | ${o.runs} | ${o.hitRate} | ${o.direct} | ${o.indirect} | ${o.ko} | ${fixed(o.avgExtras, 2)} | ${fixed(o.avgCostUsd, 3)} | ${fixed(o.avgTurns, 1)} | ${o.notSuccess} |`,
    ),
    '',
    '## Per task',
    '',
    `| Task | Group | Expected | ${variants.join(' | ')} |`,
    `| :-- | :-- | :-- | ${variants.map(() => ':--').join(' | ')} |`,
  ];
  for (const task of tasks) {
    const cells = variants.map((variant) => {
      const runs = records.filter((r) => r.variant === variant && r.taskId === task.id);
      if (runs.length === 0) return '–';
      const hits = runs.filter((r) => r.score.hit).length;
      const picked = [...new Set(runs.flatMap((r) => r.score.selected))];
      return `${hits}/${runs.length} · ${picked.join(', ') || '(none)'}`;
    });
    if (cells.every((c) => c === '–')) continue;
    lines.push(`| ${task.id} | ${task.group} | ${task.expected.join(', ')} | ${cells.join(' | ')} |`);
  }

  return { markdown: `${lines.join('\n')}\n`, overall };
}
