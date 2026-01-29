# grep-bench

To install dependencies:

```bash
bun install
```

# models to test...

- gpt-5.2-codex
- claude-sonnet-4-5
- gemini-3-flash
- minimax-m2.1-free
- glm-4.7-free
- kimi-k2.5-free
- qwen3-coder
- claude-sonnet-4-5

run the btca ask command on each model, keep track of:

- time to run
- tool call counts
- tokens in/out
- number of "turns" (requests/responses)
- cost of the run
- accuracy of the response
