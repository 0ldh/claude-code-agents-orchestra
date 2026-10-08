# Routing eval

Does the Agent Orchestra Index in `CLAUDE.md.example` help Claude pick the right specialist?

The index was added because of [Vercel's agent evals](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals), where a passive docs index beat on-demand skills. This eval checks whether that holds for this repo's own task: routing a request to one of the 47 agents.

## What it measures

The framework stops at its approval gate, so a single `claude -p` run ends with an `EXECUTION PLAN` and changes nothing. For each task the runner:

1. Builds a throwaway project with the variant's `CLAUDE.md`, every agent in `.claude/agents/`, and the `agents/` tree the index points to.
2. Runs `claude -p --output-format stream-json` with the task as the prompt. `Bash`, `Edit`, `Write` and `NotebookEdit` are denied.
3. Collects the agents Claude picked: the `subagent_type` of every `Agent`/`Task` call from the main thread, plus the agents named under `Assigned to` and `Agent List` in the plan.
4. Scores a **hit** if any expected agent was picked. Specialists picked beyond the expected ones are counted as **extras** (orchestration agents such as `tech-lead-orchestrator` are not counted).

This is plan-time routing only. It does not judge whether the specialist then does the work well.

## Variants

| Variant    | `CLAUDE.md`                                                                          |
| :--------- | :----------------------------------------------------------------------------------- |
| `index`    | `CLAUDE.md.example` as shipped                                                       |
| `no-index` | Same file with the `AGENT ORCHESTRA INDEX` section (team index, retrieval map, trigger keywords) removed |

Add a variant in `VARIANTS` in `lib.ts`.

## Tasks

`tasks.json` has 30 tasks in three groups:

| Group      | Count | What it tests                                                                                                    |
| :--------- | ----: | :--------------------------------------------------------------------------------------------------------------- |
| `direct`   |    18 | The prompt names the technology ("Add a Stripe Checkout…"). It contains a trigger keyword of an expected agent.  |
| `indirect` |     8 | The prompt describes a symptom only ("Screen reader users can't tell which tab is selected"). No trigger keyword. |
| `ko`       |     4 | Korean prompts. The trigger keywords are English, so this checks whether routing still works.                    |

`expected` lists every agent that counts as a correct pick. The tests check that each expected agent exists and that the `direct`/`indirect` labels agree with the trigger keywords in `CLAUDE.md.example`, so the set fails loudly when agents are renamed or keywords change.

## Running it

Requires Node.js 22.18 or later (the scripts are TypeScript run directly by Node) and an authenticated `claude` CLI.

```bash
cd evals/routing
npm test                     # harness tests, uses a fake claude, costs nothing
node run.ts --dry-run        # builds one sandbox per variant and prints the plan
node run.ts                  # 30 tasks × 2 variants = 60 Claude Code runs
node run.ts --repeat 3 --tasks screen-reader-tabs,ko-modal-focus
```

Claude Code also loads `~/.claude/CLAUDE.md` and `~/.claude/agents/`. If the framework is installed there, the `no-index` variant would still see the index, so the runner refuses to start while they exist. Move them aside for the run, or pass `--allow-user-config` if you are sure they do not affect routing.

Each run is a full Claude Code session that may call `tech-lead-orchestrator`, so expect real usage. Start with `--tasks` on a few ids, and use `--repeat` before trusting small differences: routing is not deterministic.

Results go to `results/<timestamp>/`: `summary.md` (tables), `summary.json` (every run) and `raw/` (the stream of each run, ignored by git).

`node run.ts --help` lists every option.
