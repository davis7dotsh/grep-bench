import { generateText, type LanguageModel } from "ai";
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

type SmokeTest = {
  name: string;
  model: LanguageModel;
  providerOptions?: SharedV3ProviderOptions;
};

const zenKey = process.env.OPENCODE_API_KEY;
if (!zenKey) throw new Error("OPENCODE_API_KEY is missing from environment.");

const openRouterKey = process.env.OPENROUTER_API_KEY;
if (!openRouterKey) {
  throw new Error("OPENROUTER_API_KEY is missing from environment.");
}

const anthropic = createAnthropic({
  apiKey: zenKey,
  baseURL: "https://opencode.ai/zen/v1",
});

const openai = createOpenAI({
  apiKey: zenKey,
  baseURL: "https://opencode.ai/zen/v1",
});

const openrouter = createOpenRouter({ apiKey: openRouterKey });

const tests: SmokeTest[] = [
  {
    name: "council: claude-opus-4-7 via Zen Anthropic messages, medium effort",
    model: anthropic("claude-opus-4-7"),
    providerOptions: { anthropic: { effort: "medium" } },
  },
  {
    name: "council: gpt-5.5 via Zen OpenAI responses, medium reasoning",
    model: openai("gpt-5.5"),
    providerOptions: { openai: { reasoningEffort: "medium" } },
  },
  {
    name: "bench: gpt-5.3-codex-spark via Zen OpenAI responses, medium reasoning",
    model: openai("gpt-5.3-codex-spark"),
    providerOptions: { openai: { reasoningEffort: "medium" } },
  },
  {
    name: "bench: claude-haiku-4-5 via Zen Anthropic messages",
    model: anthropic("claude-haiku-4-5"),
  },
  {
    name: "bench: gpt-5.4-mini via Zen OpenAI responses, medium reasoning",
    model: openai("gpt-5.4-mini"),
    providerOptions: { openai: { reasoningEffort: "medium" } },
  },
  {
    name: "bench: gpt-5.5 via Zen OpenAI responses, low reasoning",
    model: openai("gpt-5.5"),
    providerOptions: { openai: { reasoningEffort: "low" } },
  },
  {
    name: "bench: x-ai/grok-4.3 via OpenRouter",
    model: openrouter("x-ai/grok-4.3"),
  },
];

const runSmokeTest = async (test: SmokeTest) => {
  const started = Date.now();

  try {
    const result = await generateText({
      model: test.model,
      prompt: 'Reply with exactly: "ok"',
      maxOutputTokens: 16,
      providerOptions: test.providerOptions,
    });

    return {
      name: test.name,
      ok: true,
      durationMs: Date.now() - started,
      text: result.text.trim(),
      usage: result.usage,
    };
  } catch (error) {
    return {
      name: test.name,
      ok: false,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const results = [];
for (const test of tests) {
  console.log(`Smoking ${test.name}...`);
  const result = await runSmokeTest(test);
  results.push(result);
  console.log(JSON.stringify(result, null, 2));
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} smoke tests failed.`);
  process.exit(1);
}

console.log(`\nAll ${results.length} smoke tests passed.`);
