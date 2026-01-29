# Benchmark plan

## Goals

- Measure how well different models answer a fixed search harness prompt using btca server search.
- Capture consistent, comparable run metrics and response quality across models.
- Produce a repeatable procedure with clear inputs, outputs, and scoring rules.

## Scope

- Models listed in `README.md` plus any future additions.
- Single harness prompt set (initially the betterContext server install/usage question and follow-up).
- btca server-backed search only (no external web search).

## Inputs

- Models list from `README.md`.
- Prompt set:
  1. Install and use better context server in a Bun/TS app; stream consumption.
  2. How the CLI/TUI uses the server under the hood.
- btca server configuration and resources for the betterContext repo.

## Outputs

- Per-model run record (JSON or CSV) including:
  - model id
  - start/end timestamps
  - duration
  - tool call count
  - tokens in/out
  - turn count
  - cost
  - response text
  - accuracy score and notes
- Aggregate comparison table and summary.

## Metrics definition

- Duration: wall-clock elapsed time for the full response.
- Tool calls: total tool invocations reported by btca server stream events.
- Tokens: input/output token counts from btca server metadata or final event.
- Turns: count of distinct request/response exchanges per run.
- Cost: per-run cost reported by server or computed from model pricing.
- Accuracy: rubric-based score (see below).

## Accuracy rubric (initial)

- 0: incorrect or fabricated details; fails to answer.
- 1: partially relevant but missing key steps or incorrect APIs.
- 2: mostly correct, minor omissions or unclear steps.
- 3: correct, complete, and aligned with repo docs.
- 4: correct, complete, and includes precise file references or API names.

## Harness procedure

- For each model:
  - Start btca server (local, known port).
  - Submit prompt 1 via btca server streaming endpoint.
  - Capture stream events and derived metrics.
  - Submit prompt 2 using same server session.
  - Capture metrics and final response.
  - Persist per-model record.

## Validation

- Ensure the server resources include the betterContext repo.
- Confirm stream parsing yields meta/tool/delta/done events.
- Verify all required metrics exist in each run record.

## Data format

- Prefer line-delimited JSON (`.jsonl`) with one object per run.
- Include raw stream event log for debugging in a sidecar file.

## Reporting

- Summarize runs in a table with duration, tool calls, tokens, turns, cost, accuracy.
- Highlight accuracy deltas and notable failures.

## Next steps

- Add more prompts and repositories to broaden coverage.
- Introduce automatic accuracy checks where possible (golden answers).
- Add regression tracking across time and model versions.
