import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

type SmokeModel = {
  label: string;
  provider: "opencode" | "opencode-spark" | "openrouter";
  modelId: string;
  thinkingLevel?: ThinkingLevel;
};

type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number;
};

const smokeModels: SmokeModel[] = [
  {
    label: "council: claude-opus-4-7 via opencode low",
    provider: "opencode",
    modelId: "claude-opus-4-7",
    thinkingLevel: "low",
  },
  {
    label: "council: gpt-5.5 via opencode low",
    provider: "opencode",
    modelId: "gpt-5.5",
    thinkingLevel: "low",
  },
  {
    label: "bench: gpt-5.3-codex-spark via opencode medium",
    provider: "opencode-spark",
    modelId: "gpt-5.3-codex-spark",
    thinkingLevel: "medium",
  },
  {
    label: "bench: claude-haiku-4-5 via opencode default",
    provider: "opencode",
    modelId: "claude-haiku-4-5",
  },
  {
    label: "bench: gpt-5.4-mini via opencode medium",
    provider: "opencode",
    modelId: "gpt-5.4-mini",
    thinkingLevel: "medium",
  },
  {
    label: "bench: gpt-5.5 via opencode low",
    provider: "opencode",
    modelId: "gpt-5.5",
    thinkingLevel: "low",
  },
  {
    label: "bench: x-ai/grok-4.3 via openrouter default",
    provider: "openrouter",
    modelId: "x-ai/grok-4.3",
  },
];

const projectRoot = process.cwd();
const cwd = join(projectRoot, ".pi-bench", "smoke-workspace");

const assertEnv = () => {
  if (!process.env.OPENCODE_API_KEY) {
    throw new Error("OPENCODE_API_KEY is missing from environment.");
  }
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is missing from environment.");
  }
};

const setupWorkspace = async () => {
  await rm(cwd, { recursive: true, force: true });
  await mkdir(join(cwd, "fixture-repo"), { recursive: true });
  await writeFile(
    join(cwd, "fixture-repo", "answer.md"),
    "# Smoke fixture\n\nThe secret bench smoke answer is pi-smoke-ok.\n",
  );
  await writeFile(
    join(cwd, "models.json"),
    JSON.stringify(
      {
        providers: {
          "opencode-spark": {
            baseUrl: "https://opencode.ai/zen/v1",
            api: "openai-responses",
            apiKey: "OPENCODE_API_KEY",
            authHeader: true,
            models: [
              {
                id: "gpt-5.3-codex-spark",
                name: "GPT 5.3 Codex Spark (OpenCode Zen)",
                reasoning: true,
                input: ["text"],
                contextWindow: 400000,
                maxTokens: 128000,
                cost: {
                  input: 1.75,
                  output: 14,
                  cacheRead: 0.175,
                  cacheWrite: 0,
                },
              },
            ],
          },
        },
      },
      null,
      2,
    ),
  );
};

const resolveModel = (
  modelRegistry: ModelRegistry,
  entry: SmokeModel,
): Model<any> => {
  const model = modelRegistry.find(entry.provider, entry.modelId);
  if (!model) {
    throw new Error(`Model not found: ${entry.provider}/${entry.modelId}`);
  }
  return model;
};

const usageTotals = (messages: unknown[]): UsageTotals => {
  const assistants = messages.filter(
    (message): message is AssistantMessage =>
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      message.role === "assistant" &&
      "usage" in message,
  );

  return assistants.reduce(
    (total, message) => ({
      inputTokens: total.inputTokens + message.usage.input,
      outputTokens: total.outputTokens + message.usage.output,
      totalTokens: total.totalTokens + message.usage.totalTokens,
      costUSD: total.costUSD + message.usage.cost.total,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 },
  );
};

const assistantText = (messages: unknown[]) =>
  messages
    .filter(
      (message): message is AssistantMessage =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "assistant",
    )
    .flatMap((message) => message.content)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

const runSmoke = async (entry: SmokeModel) => {
  const authStorage = AuthStorage.create();
  authStorage.setRuntimeApiKey("opencode", process.env.OPENCODE_API_KEY ?? "");
  authStorage.setRuntimeApiKey(
    "opencode-spark",
    process.env.OPENCODE_API_KEY ?? "",
  );
  authStorage.setRuntimeApiKey(
    "openrouter",
    process.env.OPENROUTER_API_KEY ?? "",
  );
  const modelRegistry = ModelRegistry.create(
    authStorage,
    join(cwd, "models.json"),
  );
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    systemPromptOverride: () =>
      "You are a smoke-test coding agent. Use tools when asked. Be concise.",
  });
  await resourceLoader.reload();

  const model = resolveModel(modelRegistry, entry);
  const startedAt = Date.now();
  let toolCalls = 0;
  let textStartedAt: number | null = null;
  let textEndedAt: number | null = null;

  const { session } = await createAgentSession({
    cwd,
    model,
    ...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    tools: ["read", "bash"],
  });

  session.subscribe((event) => {
    if (event.type === "tool_execution_start") toolCalls += 1;
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      textStartedAt ??= Date.now();
      textEndedAt = Date.now();
    }
  });

  try {
    await session.prompt(
      [
        "Use the exec tool to find the secret answer in fixture-repo, then use the read tool to inspect the file that contains it.",
        'Reply with exactly one short sentence containing "pi-smoke-ok".',
      ].join("\n"),
    );

    const wallClockSec = (Date.now() - startedAt) / 1000;
    const usage = usageTotals(session.messages);
    const text = assistantText(session.messages);
    const generationSec =
      textStartedAt !== null && textEndedAt !== null
        ? Math.max((textEndedAt - textStartedAt) / 1000, 0.001)
        : wallClockSec;

    return {
      label: entry.label,
      ok: text.includes("pi-smoke-ok"),
      provider: entry.provider,
      model: entry.modelId,
      thinkingLevel: entry.thinkingLevel ?? session.thinkingLevel,
      wallClockSec,
      toolCalls,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      tokensPerSecond: usage.outputTokens / generationSec,
      wallClockTokensPerSecond: usage.outputTokens / wallClockSec,
      costUSD: usage.costUSD,
      text,
    };
  } finally {
    session.dispose();
  }
};

assertEnv();
await setupWorkspace();

const results = [];
for (const entry of smokeModels) {
  console.log(`Smoking ${entry.label}...`);
  const result = await runSmoke(entry);
  results.push(result);
  console.log(JSON.stringify(result, null, 2));
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} Pi smoke tests failed.`);
  process.exit(1);
}

console.log(`\nAll ${results.length} Pi smoke tests passed.`);
