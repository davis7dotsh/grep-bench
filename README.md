# grep-bench

Pi SDK local-repo search benchmark for coding-agent models. It prepares local repositories/packages once, runs one fresh Pi SDK session per `(model, test, run)`, and scores source-backed answers with a Pi SDK judge council.

## Setup

Install dependencies:

```bash
bun install
```

Ensure:

- `OPENCODE_API_KEY` is set (required for OpenCode bench and council models).
- `OPENROUTER_API_KEY` is set (required for OpenRouter bench models).
- `git` is available for resource checkout.

## Run

```bash
bun run bench
```

Flags:

- `--runs <n>` or `-r <n>`: set per-test run count (default `1`).
- `--model <name>` or `-m <name>`: run only one model.

Example:

```bash
bun run bench --runs 1 --model gpt-5.4-mini
```

If `--model` is not in the default list, it runs with provider `opencode`.

## What is benchmarked

The default bench model set is:

- `gpt-5.3-codex-spark` via `opencode-spark` custom provider, thinking `medium`
- `claude-haiku-4-5` via `opencode`
- `gpt-5.4-mini` via `opencode`, thinking `medium`
- `gpt-5.5` via `opencode`, thinking `low`
- `x-ai/grok-4.3` via `openrouter`

Council judges:

- `claude-opus-4-7` via `opencode`, thinking `low`
- `gpt-5.5` via `opencode`, thinking `low`

The suite runs the V2 fixed test list in `src/bench.ts`:

- 13 test prompts total
- Resources used: `svelte`, `tailwindcss`, `justBash`, `daytona`
- Git repos are cached under `.pi-bench/cache/repos`
- Timestamped run workspaces are created under `.pi-bench/workspaces/<timestamp>`

## Runtime flow

For each selected model, `src/bench.ts`:

- Prepares all local resources before model runs.
- Creates a bench-local `models.json` with the `gpt-5.3-codex-spark` custom provider workaround.
- Runs tests sequentially within each model and models in parallel.
- Creates a fresh in-memory Pi SDK coding-agent session per `(model, test, run)`.
- Exposes only `read` and `bash` tools to benchmark agents.
- Runs council judging through Pi SDK sessions with no tools.
- Extracts wall-clock time, time to first model delta, tool calls, input/output/total tokens, output tokens/sec, and cost.

## Output

Raw records are written to:

```text
results/bench-results-<timestamp>.jsonl
```

Each line is a full JSON record with:

- question metadata
- local resource path
- raw answer
- token/cost/timing metrics
- tool usage and error fields
- judge score/clarity/votes and disagreement stats

The terminal summary prints averages for:

- duration
- time to first model delta
- tool calls
- judge score
- clarity
- input/output tokens
- output wall-clock tokens/sec
- cost
- failed run count

With `--model`, the summary is grouped by `testId` instead of model.

## Regression check

`src/pi_smoke_test.ts` is kept as a Pi SDK regression smoke test:

```bash
bun run src/pi_smoke_test.ts
```
