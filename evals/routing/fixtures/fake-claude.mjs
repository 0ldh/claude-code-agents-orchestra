#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json` used by run.test.ts.
// It checks the sandbox the runner built and emits a small, deterministic stream.
import { existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('0.0.0 (fake)');
  process.exit(0);
}
if (!args.includes('-p') || args[args.indexOf('--disallowedTools') + 1] !== 'Bash,Edit,Write,NotebookEdit') {
  console.error(`unexpected args: ${args.join(' ')}`);
  process.exit(2);
}
if (!existsSync('.claude/agents/react-expert.md') || !existsSync('agents/development/frontend/react/react-expert.md')) {
  console.error('sandbox is missing agent files');
  process.exit(3);
}

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;

const hasIndex = readFileSync('CLAUDE.md', 'utf8').includes('## AGENT ORCHESTRA INDEX');
// With the index the fake routes React prompts correctly; without it, it always picks typescript-expert.
const pick = hasIndex && /react/i.test(prompt) ? 'react-expert' : 'typescript-expert';

const emit = (event) => console.log(JSON.stringify(event));
emit({ type: 'system', subtype: 'init', session_id: 'fake' });
emit({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Agent', input: { subagent_type: 'tech-lead-orchestrator', prompt } }] },
});
emit({
  type: 'assistant',
  parent_tool_use_id: 'tu_1',
  message: { content: [{ type: 'tool_use', id: 'tu_2', name: 'Agent', input: { subagent_type: 'security-auditor' } }] },
});
emit({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'blueprint' }] } });
const plan = `📋 EXECUTION PLAN\nClassification: Complex\nAssigned to: @tech-lead-orchestrator\n\nAgent List:\n[@${pick}]: do the work\n\n⚠️ AWAITING APPROVAL`;
emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: plan }] } });
emit({ type: 'result', subtype: 'success', result: plan, total_cost_usd: 0.01, num_turns: 2, duration_ms: 5 });
