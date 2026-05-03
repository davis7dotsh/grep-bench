import { cp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
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

type BenchModel = {
  model: string;
  provider: string;
  effectiveProvider?: string;
  thinkingLevel?: ThinkingLevel;
};

type ResourceConfig = {
  type: "git" | "npm";
  name: string;
  url?: string;
  branch?: string;
  package?: string;
  searchPath?: string;
  notes?: string;
};

type BenchTest = {
  id: string;
  question: string;
  resourceName: string;
  expected: { requiredAny: string[][] };
};

type ResourceState = ResourceConfig & {
  localPath: string;
  commit?: string;
};

type PiServices = {
  authStorage: ReturnType<typeof AuthStorage.create>;
  modelRegistry: ModelRegistry;
  modelsJsonPath: string;
};

type RunResult = {
  answer: string;
  toolCalls: number;
  tokens: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    total: number | null;
  };
  costUSD: number | null;
  durationSec: number;
  timeToFirstModelDeltaMs: number | null;
  outputWallClockTps: number | null;
};

const RESOURCES: ResourceConfig[] = [
  {
    type: "git",
    name: "svelte",
    url: "https://github.com/sveltejs/svelte.dev",
    branch: "main",
    searchPath: "apps/svelte.dev",
    notes:
      "Svelte docs website repo. Focus on markdown content under apps/svelte.dev.",
  },
  {
    type: "git",
    name: "tailwindcss",
    url: "https://github.com/tailwindlabs/tailwindcss.com",
    branch: "main",
    searchPath: "src/docs",
    notes: "Tailwind CSS docs website repo.",
  },
  {
    type: "git",
    name: "justBash",
    url: "https://github.com/vercel-labs/just-bash",
    branch: "main",
  },
  {
    type: "git",
    name: "daytona",
    url: "https://github.com/daytonaio/daytona",
    branch: "main",
    notes:
      "Full Daytona monorepo. Start in docs/examples, then source if needed.",
  },
];

const TESTS: BenchTest[] = [
  {
    id: "svelte-load-functions-source-backed",
    resourceName: "svelte",
    question:
      "Using only the local Svelte docs repo, compare SvelteKit +page.ts and +page.server.ts load functions. Include:\n1. exact docs file path(s) you used\n2. where each runs\n3. what each can access that the other cannot\n4. serialization constraints, including devalue\n5. minimal examples for both files and data usage in +page.svelte",
    expected: {
      requiredAny: [
        ["+page.ts"],
        ["+page.server.ts"],
        ["universal", "PageLoad"],
        ["server", "PageServerLoad"],
        ["devalue", "serializable"],
        ["apps/svelte.dev", "content", ".md"],
      ],
    },
  },
  {
    id: "svelte-form-actions-source-backed",
    resourceName: "svelte",
    question:
      "Find the SvelteKit docs/tutorial source for form actions and use:enhance. Show a complete minimal +page.server.ts and +page.svelte flow with validation using fail(...), success redirect using redirect(...), and error rendering. Include the exact import path for enhance and the exact docs/tutorial file path(s) you used.",
    expected: {
      requiredAny: [
        ["+page.server.ts"],
        ["use:enhance"],
        ["$app/forms"],
        ["fail("],
        ["redirect("],
        ['method="post"', "method='post'"],
        ["apps/svelte.dev", "content", ".md"],
      ],
    },
  },
  {
    id: "sveltekit-negative-nonexistent-api",
    resourceName: "svelte",
    question:
      "Using only the Svelte docs repo, determine whether SvelteKit has a documented helper named enhanceForm. If it does not, identify the documented helper that provides progressive enhancement for forms, include its exact import path, and cite the local docs/tutorial file path where you found it.",
    expected: {
      requiredAny: [
        ["enhanceForm"],
        ["not", "does not", "no documented"],
        ["enhance"],
        ["$app/forms"],
        ["apps/svelte.dev", "content", ".md"],
      ],
    },
  },
  {
    id: "tailwind-theme-namespace-mapping",
    resourceName: "tailwindcss",
    question:
      "In the Tailwind CSS v4 docs, explain how @theme variables map to generated utility classes. Include at least three variable namespaces and the utilities they generate, plus a minimal CSS and HTML example. Cite the exact local docs file path(s) you used.",
    expected: {
      requiredAny: [
        ["@theme"],
        ["--color-"],
        ["--spacing-", "--radius-", "--font-"],
        ["bg-", "text-", "p-", "rounded-", "font-"],
        ["src/docs", ".md", ".mdx"],
      ],
    },
  },
  {
    id: "tailwind-utility-functional-variants",
    resourceName: "tailwindcss",
    question:
      "Using the Tailwind CSS v4 docs, show both a simple custom utility and a functional utility using @utility. Explain how hover: and responsive variants like md: apply to custom utilities. Include one concrete CSS+HTML example and cite the exact local docs file path(s) you used.",
    expected: {
      requiredAny: [
        ["@utility"],
        ["functional", "--value("],
        ["hover:"],
        ["md:", "sm:", "lg:"],
        ["src/docs", ".md", ".mdx"],
      ],
    },
  },
  {
    id: "justbash-directory-restriction-exact",
    resourceName: "justBash",
    question:
      "In the just-bash repo, find the documented or implemented mechanism for restricting an agent to read/write only one directory. Include exact config keys or command options, a minimal config snippet or command, and the exact local file path(s) where this is documented or implemented.",
    expected: {
      requiredAny: [
        ["root"],
        ["readwritefs", "--root", "overlayfs"],
        ["sandbox", "just-bash", "new bash"],
        [".ts", ".md", ".go", ".rs"],
      ],
    },
  },
  {
    id: "justbash-approval-policy-schema",
    resourceName: "justBash",
    question:
      "In just-bash, find how command approval policies are represented and applied. Show a minimal policy that requires approval for a risky command such as rm -rf, explain how sandbox behavior relates to approval, and cite the exact local source/doc file path(s) you used.",
    expected: {
      requiredAny: [
        ["approval", "approve"],
        ["policy", "policies"],
        ["sandbox"],
        ["rm -rf", "dangerous", "risky"],
        ["runCommand", "run command", "command execution"],
      ],
    },
  },
  {
    id: "justbash-negative-allow-all-flag",
    resourceName: "justBash",
    question:
      "Using only the just-bash repo, determine whether there is a documented CLI flag named --allow-all. If it does not exist, explain the closest supported mechanism for broad command/file access and cite the exact local file path(s) you searched or used.",
    expected: {
      requiredAny: [
        ["--allow-all"],
        ["not", "does not", "no"],
        ["approval", "sandbox", "root", "policy"],
        [".md", ".ts", ".go", ".rs"],
      ],
    },
  },
  {
    id: "daytona-autostop-default-source-backed",
    resourceName: "daytona",
    question:
      "In the Daytona repo, find the source or docs that define Daytona's default sandbox auto-stop behavior. Provide the exact default value, where it is configured, and the exact local file path(s) and symbol/command/doc section you used.",
    expected: {
      requiredAny: [
        ["15"],
        ["auto-stop", "autostop"],
        ["create.go", "daytona_create.md"],
        ["default", "config"],
      ],
    },
  },
  {
    id: "daytona-create-start-execute-examples",
    resourceName: "daytona",
    question:
      "In the Daytona repo, find either CLI docs or TypeScript SDK examples for creating/starting a sandbox and executing a command. Provide the minimal workflow with exact command/API names and cite the exact local files you used.",
    expected: {
      requiredAny: [
        ["daytona create", "daytona.create("],
        ["daytona start", "sandbox.start"],
        ["daytona exec", "executeCommand", "executecommand"],
        ["examples", "docs", ".md", ".ts"],
      ],
    },
  },
  {
    id: "daytona-negative-fabricated-command",
    resourceName: "daytona",
    question:
      "Using only the Daytona repo, determine whether there is a documented CLI command named `daytona sandbox run`. If not, identify the documented command or SDK method for executing a command in a sandbox and cite the exact local file path(s) you used.",
    expected: {
      requiredAny: [
        ["daytona sandbox run"],
        ["not", "does not", "no documented"],
        ["daytona exec", "executeCommand", "executecommand"],
        ["docs", "examples", ".md", ".ts"],
      ],
    },
  },
];

const MODELS: BenchModel[] = [
  {
    model: "gpt-5.3-codex-spark",
    provider: "opencode",
    effectiveProvider: "opencode-spark",
    thinkingLevel: "medium",
  },
  { model: "claude-haiku-4-5", provider: "opencode" },
  { model: "gpt-5.4-mini", provider: "opencode", thinkingLevel: "medium" },
  { model: "gpt-5.5", provider: "opencode", thinkingLevel: "low" },
  { model: "x-ai/grok-4.3", provider: "openrouter" },
];

const COUNCIL: BenchModel[] = [
  { model: "claude-opus-4-7", provider: "opencode", thinkingLevel: "low" },
  { model: "gpt-5.5", provider: "opencode", thinkingLevel: "low" },
];

const round = (value: number) => Math.round(value * 100) / 100;
const safeJson = (value: string) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};
const formatError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const buildTimestamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const sanitize = (value: string) => value.replace(/[^a-z0-9-_]+/gi, "-");

const parseRuns = (args: string[]) => {
  const index = args.findIndex((arg) => arg === "--runs" || arg === "-r");
  const value =
    index >= 0 ? args[index + 1] : args.find((arg) => /^\d+$/.test(arg));
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const parseModel = (args: string[]) => {
  const index = args.findIndex((arg) => arg === "--model" || arg === "-m");
  return index >= 0 ? (args[index + 1] ?? null) : null;
};

const writeModelsJson = async (workspaceRoot: string) => {
  const path = join(workspaceRoot, "models.json");
  await writeFile(
    path,
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
  return path;
};

const ensureGitCache = async (resource: ResourceConfig, cacheRoot: string) => {
  const target = join(cacheRoot, sanitize(resource.name));
  if (!existsSync(target)) {
    await Bun.$`git clone --depth 1 --branch ${resource.branch ?? "main"} ${resource.url} ${target}`;
  } else {
    await Bun.$`git -C ${target} fetch --depth 1 origin ${resource.branch ?? "main"}`;
    await Bun.$`git -C ${target} checkout ${resource.branch ?? "main"}`;
    await Bun.$`git -C ${target} reset --hard FETCH_HEAD`;
  }
  const commit = (await Bun.$`git -C ${target} rev-parse HEAD`.text()).trim();
  return { cachePath: target, commit };
};

const prepareWorkspace = async (resources: ResourceConfig[]) => {
  const workspaceRoot = join(
    process.cwd(),
    ".pi-bench",
    "workspaces",
    buildTimestamp(),
  );
  const cacheRoot = join(process.cwd(), ".pi-bench", "cache", "repos");
  await mkdir(join(workspaceRoot, "repos"), { recursive: true });
  await mkdir(join(workspaceRoot, "npm"), { recursive: true });
  await mkdir(cacheRoot, { recursive: true });
  const modelsJsonPath = await writeModelsJson(workspaceRoot);
  const resourceMap = new Map<string, ResourceState>();

  for (const resource of resources) {
    if (resource.type === "git") {
      const { cachePath, commit } = await ensureGitCache(resource, cacheRoot);
      const localPath = join(workspaceRoot, "repos", sanitize(resource.name));
      const gitDir = join(cachePath, ".git");
      await cp(cachePath, localPath, {
        recursive: true,
        filter: (src) => src !== gitDir && !src.startsWith(`${gitDir}${sep}`),
      });
      resourceMap.set(resource.name, { ...resource, localPath, commit });
    } else {
      const source = join(
        process.cwd(),
        "node_modules",
        resource.package ?? resource.name,
      );
      if (!existsSync(source))
        throw new Error(`Missing npm package: ${source}`);
      const localPath = join(workspaceRoot, "npm", resource.name);
      await cp(source, localPath, { recursive: true });
      resourceMap.set(resource.name, { ...resource, localPath });
    }
  }

  return { workspaceRoot, modelsJsonPath, resourceMap };
};

const createPiServices = (modelsJsonPath: string): PiServices => {
  const authStorage = AuthStorage.create();
  authStorage.setRuntimeApiKey("opencode", process.env.OPENCODE_API_KEY ?? "");
  authStorage.setRuntimeApiKey(
    "openrouter",
    process.env.OPENROUTER_API_KEY ?? "",
  );
  authStorage.setRuntimeApiKey(
    "opencode-spark",
    process.env.OPENCODE_API_KEY ?? "",
  );
  return {
    authStorage,
    modelRegistry: ModelRegistry.create(authStorage, modelsJsonPath),
    modelsJsonPath,
  };
};

const resolveModel = (services: PiServices, config: BenchModel): Model<any> => {
  const provider = config.effectiveProvider ?? config.provider;
  const model = services.modelRegistry.find(provider, config.model);
  if (!model) throw new Error(`Model not found: ${provider}/${config.model}`);
  return model;
};

const usageTotals = (messages: unknown[]) =>
  messages
    .filter(
      (message): message is AssistantMessage =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "assistant" &&
        "usage" in message,
    )
    .reduce(
      (total, message) => ({
        input: total.input + message.usage.input,
        output: total.output + message.usage.output,
        cacheRead: total.cacheRead + message.usage.cacheRead,
        cacheWrite: total.cacheWrite + message.usage.cacheWrite,
        total: total.total + message.usage.totalTokens,
        cost: total.cost + message.usage.cost.total,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
    );

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

const createResourceLoader = async (
  cwd: string,
  settingsManager: ReturnType<typeof SettingsManager.inMemory>,
  system: string,
) => {
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    systemPromptOverride: () => system,
  });
  await resourceLoader.reload();
  return resourceLoader;
};

const runPiAgentQuestion = async (
  workspaceRoot: string,
  services: PiServices,
  modelConfig: BenchModel,
  prompt: string,
): Promise<RunResult> => {
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
  });
  const resourceLoader = await createResourceLoader(
    workspaceRoot,
    settingsManager,
    "You are a benchmark coding agent. Use local files only. Be concise and exact.",
  );
  const started = Date.now();
  let toolCalls = 0;
  let firstModelDeltaAt: number | null = null;
  const { session } = await createAgentSession({
    cwd: workspaceRoot,
    model: resolveModel(services, modelConfig),
    ...(modelConfig.thinkingLevel
      ? { thinkingLevel: modelConfig.thinkingLevel }
      : {}),
    authStorage: services.authStorage,
    modelRegistry: services.modelRegistry,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    tools: ["read", "bash"],
  });
  session.subscribe((event) => {
    if (event.type === "tool_execution_start") toolCalls += 1;
    if (event.type === "message_update") {
      const type = event.assistantMessageEvent.type;
      if (type !== "start") firstModelDeltaAt ??= Date.now();
    }
  });
  try {
    await session.prompt(prompt);
    const finished = Date.now();
    const usage = usageTotals(session.messages);
    const durationSec = round((finished - started) / 1000);
    return {
      answer: assistantText(session.messages),
      toolCalls,
      tokens: {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        total: usage.total,
      },
      costUSD: usage.cost,
      durationSec,
      timeToFirstModelDeltaMs:
        firstModelDeltaAt === null ? null : firstModelDeltaAt - started,
      outputWallClockTps: durationSec > 0 ? usage.output / durationSec : null,
    };
  } finally {
    session.dispose();
  }
};

const makeBenchPrompt = (test: BenchTest, resource: ResourceState) =>
  [
    "You are answering a documentation/codebase question.",
    `Resource name: ${resource.name}`,
    `Local path: ${resource.localPath}`,
    resource.searchPath
      ? `Primary search path: ${join(resource.localPath, resource.searchPath)}`
      : "",
    resource.notes ? `Notes: ${resource.notes}` : "",
    `Question:\n${test.question}`,
    "Instructions:\n- Answer using only the local resource path above.\n- Use bash to search and read to inspect relevant files.\n- Do not use web or outside knowledge.\n- Include exact local file paths for the evidence you used.\n- Include exact API names, file names, flags, defaults, symbols, or commands when requested.\n- Be concise.",
  ]
    .filter(Boolean)
    .join("\n\n");

const parseJudgeResponse = (raw: string) => {
  const parsed = safeJson(raw.match(/\{[\s\S]*\}/)?.[0] ?? "");
  if (!parsed || typeof parsed.score !== "number") return null;
  return {
    score: Math.max(0, Math.min(4, parsed.score)),
    clarity:
      typeof parsed.clarity === "number"
        ? Math.max(0, Math.min(4, parsed.clarity))
        : null,
    notes: typeof parsed.notes === "string" ? parsed.notes : null,
  };
};

const evaluateExpectedFacts = (test: BenchTest, answer: string) => {
  const normalized = answer.toLowerCase();
  const misses = test.expected.requiredAny.filter(
    (group) => !group.some((term) => normalized.includes(term.toLowerCase())),
  );
  return {
    requiredFacts: test.expected.requiredAny.length,
    missedFacts: misses.length,
    penalty: round(Math.min(2, misses.length * 0.5)),
    missedHints: misses.map((group) => group.join(" | ")),
  };
};

const runCouncilJudge = async (
  workspaceRoot: string,
  services: PiServices,
  judge: BenchModel,
  prompt: string,
) => {
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
  });
  const resourceLoader = await createResourceLoader(
    workspaceRoot,
    settingsManager,
    "You are a strict evaluator. Output JSON only.",
  );
  const { session } = await createAgentSession({
    cwd: workspaceRoot,
    model: resolveModel(services, judge),
    thinkingLevel: judge.thinkingLevel ?? "low",
    authStorage: services.authStorage,
    modelRegistry: services.modelRegistry,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    noTools: "all",
  });
  try {
    await session.prompt(prompt);
    return assistantText(session.messages);
  } finally {
    session.dispose();
  }
};

const judgeAnswer = async (
  workspaceRoot: string,
  services: PiServices,
  test: BenchTest,
  answer: string,
) => {
  const system =
    'You are a strict evaluator and must not give benefit-of-the-doubt. Usefulness score 0-4: 0 wrong/fabricated, 1 major mistakes or missing requested specifics, 2 mostly right but gaps, 3 correct and complete, 4 correct+complete with exact API names/flags/file paths when requested. If the answer invents APIs, flags, commands, defaults, or file paths not in the source, usefulness must be 0 or 1. Clarity score 0-4: 0 confusing, 1 hard to apply, 2 understandable with gaps, 3 actionable, 4 concise and implementation-ready. Output JSON only: {"score": number, "clarity": number, "notes": string}.';
  const expectedFacts = test.expected.requiredAny
    .map((group, index) => `${index + 1}. ${group.join(" OR ")}`)
    .join("\n");
  const prompt = `${system}\n\nQuestion:\n${test.question}\n\nExpected facts/signals the answer should include:\n${expectedFacts}\n\nAnswer:\n${answer}\n\nReturn JSON only.`;
  const votes = await Promise.all(
    COUNCIL.map(async (judge) => {
      try {
        const raw = await runCouncilJudge(
          workspaceRoot,
          services,
          judge,
          prompt,
        );
        return { model: judge.model, raw, parsed: parseJudgeResponse(raw) };
      } catch (error) {
        console.error(`[council] ${judge.model} failed: ${formatError(error)}`);
        return { model: judge.model, raw: "", parsed: null };
      }
    }),
  );
  const scores = votes
    .map((vote) => vote.parsed?.score)
    .filter((score): score is number => typeof score === "number");
  const clarities = votes
    .map((vote) => vote.parsed?.clarity)
    .filter((clarity): clarity is number => typeof clarity === "number");
  const avg = (nums: number[]) =>
    nums.length ? round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
  const expected = evaluateExpectedFacts(test, answer);
  const rawScore = avg(scores);
  const parseFailures = votes.filter((vote) => !vote.parsed).length;
  const parsePenalty = parseFailures > 0 ? round(parseFailures * 0.25) : 0;
  const score =
    rawScore === null
      ? null
      : round(Math.max(0, rawScore - expected.penalty - parsePenalty));
  const mean = scores.length
    ? scores.reduce((sum, vote) => sum + vote, 0) / scores.length
    : null;
  return {
    score,
    rawScore,
    clarity: avg(clarities),
    parseFailures,
    parsePenalty,
    expected,
    disagreement: {
      stdDev:
        mean === null
          ? null
          : round(
              Math.sqrt(
                scores.reduce(
                  (sum, vote) => sum + Math.pow(vote - mean, 2),
                  0,
                ) / scores.length,
              ),
            ),
      range: scores.length
        ? round(Math.max(...scores) - Math.min(...scores))
        : null,
    },
    votes,
  };
};

const runModelBench = async (
  workspaceRoot: string,
  services: PiServices,
  resourceMap: Map<string, ResourceState>,
  modelConfig: BenchModel,
  runs: number,
) => {
  const records = [];
  for (const test of TESTS) {
    const resource = resourceMap.get(test.resourceName);
    if (!resource) throw new Error(`Missing resource ${test.resourceName}`);
    for (let run = 1; run <= runs; run += 1) {
      console.log(
        `Running ${modelConfig.model} ${test.id} (${run}/${runs})...`,
      );
      const startedAt = new Date().toISOString();
      const runStartedMs = Date.now();
      try {
        const response = await runPiAgentQuestion(
          workspaceRoot,
          services,
          modelConfig,
          makeBenchPrompt(test, resource),
        );
        const judged = await judgeAnswer(
          workspaceRoot,
          services,
          test,
          response.answer,
        );
        records.push({
          summary: {
            testId: test.id,
            model: modelConfig.model,
            durationSec: response.durationSec,
            timeToFirstModelDeltaMs: response.timeToFirstModelDeltaMs,
            toolCalls: response.toolCalls,
            inputTokens: response.tokens.input,
            outputTokens: response.tokens.output,
            cacheReadTokens: response.tokens.cacheRead,
            cacheWriteTokens: response.tokens.cacheWrite,
            costUSD: response.costUSD,
            outputWallClockTps: response.outputWallClockTps,
            score: judged.score,
            clarity: judged.clarity,
            failed: false,
          },
          line: JSON.stringify({
            model: modelConfig.model,
            provider: modelConfig.provider,
            effectiveProvider: modelConfig.effectiveProvider,
            thinkingLevel: modelConfig.thinkingLevel ?? null,
            testId: test.id,
            run,
            startedAt,
            durationSec: response.durationSec,
            timeToFirstModelDeltaMs: response.timeToFirstModelDeltaMs,
            toolCalls: response.toolCalls,
            tokens: response.tokens,
            tps: { outputWallClock: response.outputWallClockTps },
            costUSD: response.costUSD,
            question: test.question,
            resources: [resource.name],
            localResourcePath: resource.localPath,
            localResourceCommit: resource.commit ?? null,
            answer: response.answer,
            error: null,
            judge: {
              score: judged.score,
              rawScore: judged.rawScore,
              clarity: judged.clarity,
              model: "council",
              parseFailures: judged.parseFailures,
              parsePenalty: judged.parsePenalty,
              expectedFacts: judged.expected,
              disagreement: judged.disagreement,
              votes: judged.votes.map((vote) => ({
                model: vote.model,
                score: vote.parsed?.score ?? null,
                clarity: vote.parsed?.clarity ?? null,
                notes: vote.parsed?.notes ?? null,
                raw: vote.raw,
              })),
            },
          }),
        });
      } catch (error) {
        const message = formatError(error);
        console.error(
          `[${modelConfig.model}] ${test.id} run ${run} failed: ${message}`,
        );
        const durationSec = round((Date.now() - runStartedMs) / 1000);
        records.push({
          summary: {
            testId: test.id,
            model: modelConfig.model,
            durationSec,
            timeToFirstModelDeltaMs: null,
            toolCalls: 0,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            costUSD: null,
            outputWallClockTps: null,
            score: null,
            clarity: null,
            failed: true,
          },
          line: JSON.stringify({
            model: modelConfig.model,
            provider: modelConfig.provider,
            effectiveProvider: modelConfig.effectiveProvider,
            thinkingLevel: modelConfig.thinkingLevel ?? null,
            testId: test.id,
            run,
            startedAt,
            durationSec,
            timeToFirstModelDeltaMs: null,
            toolCalls: 0,
            tokens: {
              input: null,
              output: null,
              cacheRead: null,
              cacheWrite: null,
              total: null,
            },
            tps: { outputWallClock: null },
            costUSD: null,
            question: test.question,
            resources: [test.resourceName],
            localResourcePath: resource.localPath,
            localResourceCommit: resource.commit ?? null,
            answer: "",
            error: message,
            judge: { score: null, clarity: null, model: "council", votes: [] },
          }),
        });
      }
    }
  }
  return records;
};

const runBench = async () => {
  if (!process.env.OPENCODE_API_KEY)
    throw new Error("OPENCODE_API_KEY is missing from environment.");
  if (!process.env.OPENROUTER_API_KEY)
    throw new Error("OPENROUTER_API_KEY is missing from environment.");
  const args = process.argv.slice(2);
  const runs = parseRuns(args);
  const modelOverride = parseModel(args);
  const entries = modelOverride
    ? MODELS.find((model) => model.model === modelOverride)
      ? MODELS.filter((model) => model.model === modelOverride)
      : [{ model: modelOverride, provider: "opencode" }]
    : MODELS;
  await mkdir("results", { recursive: true });
  const { workspaceRoot, modelsJsonPath, resourceMap } =
    await prepareWorkspace(RESOURCES);
  const services = createPiServices(modelsJsonPath);
  const resultsPath = join(
    "results",
    `bench-results-${buildTimestamp()}.jsonl`,
  );
  const modelResults = await Promise.all(
    entries.map((entry) =>
      runModelBench(workspaceRoot, services, resourceMap, entry, runs),
    ),
  );
  const records = modelResults.flat();
  await writeFile(
    resultsPath,
    records.length
      ? `${records.map((record) => record.line).join("\n")}\n`
      : "",
  );
  const summaries = records.map((record) => record.summary);
  const grouped = summaries.reduce(
    (acc, entry) => {
      const key = modelOverride ? entry.testId : entry.model;
      (acc[key] ??= []).push(entry);
      return acc;
    },
    {} as Record<string, typeof summaries>,
  );
  const avg = (values: number[]) =>
    values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  const table = Object.entries(grouped).map(([key, entries]) => {
    const nums = (
      selector: (entry: (typeof entries)[number]) => number | null,
    ) =>
      entries.map(selector).filter((value): value is number => value !== null);
    return {
      [modelOverride ? "testId" : "model"]: key,
      avgDurationSec: round(avg(entries.map((entry) => entry.durationSec))),
      avgTimeToFirstDeltaMs: nums((entry) => entry.timeToFirstModelDeltaMs)
        .length
        ? round(avg(nums((entry) => entry.timeToFirstModelDeltaMs)))
        : "n/a",
      avgToolCalls: round(avg(entries.map((entry) => entry.toolCalls))),
      avgScore: nums((entry) => entry.score).length
        ? round(avg(nums((entry) => entry.score)))
        : "n/a",
      avgClarity: nums((entry) => entry.clarity).length
        ? round(avg(nums((entry) => entry.clarity)))
        : "n/a",
      avgInputTokens: nums((entry) => entry.inputTokens).length
        ? round(avg(nums((entry) => entry.inputTokens)))
        : "n/a",
      avgOutputTokens: nums((entry) => entry.outputTokens).length
        ? round(avg(nums((entry) => entry.outputTokens)))
        : "n/a",
      avgCacheReadTokens: nums((entry) => entry.cacheReadTokens).length
        ? round(avg(nums((entry) => entry.cacheReadTokens)))
        : "n/a",
      avgCacheWriteTokens: nums((entry) => entry.cacheWriteTokens).length
        ? round(avg(nums((entry) => entry.cacheWriteTokens)))
        : "n/a",
      avgOutputWallClockTps: nums((entry) => entry.outputWallClockTps).length
        ? round(avg(nums((entry) => entry.outputWallClockTps)))
        : "n/a",
      avgCostUSD: nums((entry) => entry.costUSD).length
        ? Math.round(avg(nums((entry) => entry.costUSD)) * 1_000_000) /
          1_000_000
        : "n/a",
      failedRuns: entries.filter((entry) => entry.failed).length,
    };
  });
  console.log(
    modelOverride
      ? `\nResults for ${modelOverride}`
      : "\nSummary (avg per model)",
  );
  console.table(table);
  console.log(`\nResults written to ${resultsPath}`);
};

try {
  await runBench();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
