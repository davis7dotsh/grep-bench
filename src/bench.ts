import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";

const TESTS = [
  {
    id: "sveltekit-remote",
    question:
      "How do SvelteKit remote functions work? I need to understand the syntax and usage for calling server-side functions from the client. Show me examples of how to define and call remote functions, including the file naming conventions and any configuration needed",
    resource: {
      type: "git",
      name: "svelte",
      url: "https://github.com/sveltejs/svelte.dev",
      branch: "main",
      searchPath: "apps/svelte.dev",
    },
  },
  {
    id: "just-bash-agent-dir",
    question:
      "Using just-bash, how do I allow an agent to read/write to a specific directory? Provide the exact configuration or command needed.",
    resource: {
      type: "git",
      name: "justBash",
      url: "https://github.com/vercel-labs/just-bash",
      branch: "main",
    },
  },
  {
    id: "effect-stream-web",
    question:
      "In Effect, how do I convert an Effect Stream into a standard Web ReadableStream? Provide the exact API and a minimal example.",
    resource: {
      type: "git",
      name: "effect",
      url: "https://github.com/Effect-TS/effect",
      branch: "main",
    },
  },
  {
    id: "daytona-sandbox-autostop",
    question:
      "In Daytona, how long does a sandbox take to automatically stop by default? Give the default duration and where it is configured.",
    resource: {
      type: "git",
      name: "daytona",
      url: "https://github.com/daytonaio/daytona",
      branch: "main",
    },
  },
];
const MODELS: Array<{ model: string; provider: string }> = [
  { model: "gpt-5.2-codex", provider: "openai" },
  { model: "gpt-5.3-codex", provider: "openai" },
  { model: "claude-opus-4-6", provider: "opencode" },
  { model: "claude-opus-4-5", provider: "opencode" },
  { model: "claude-haiku-4-5", provider: "opencode" },
  { model: "gemini-3-flash", provider: "opencode" },
  { model: "minimax-m2.1", provider: "opencode" },
];
const BENCH_ROOT = ".btca-bench";
const BTCA_SCHEMA = "https://btca.dev/btca.schema.json";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const parseRuns = (args: string[]) => {
  const toCount = (value?: string) => {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  };

  const flagIndex = args.findIndex((arg) => arg === "--runs" || arg === "-r");
  if (flagIndex >= 0) return toCount(args[flagIndex + 1]);

  const positional = args.find((arg) => /^\d+$/.test(arg));
  return toCount(positional);
};

const parseModel = (args: string[]) => {
  const flagIndex = args.findIndex((arg) => arg === "--model" || arg === "-m");
  if (flagIndex >= 0) return args[flagIndex + 1] ?? null;
  return null;
};

const unique = <T>(values: T[]) => Array.from(new Set(values));

const uniqueResources = (tests: typeof TESTS) =>
  Array.from(
    new Map(tests.map((test) => [test.resource.name, test.resource])).values(),
  );

const fetchJson = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Request failed ${response.status} ${response.statusText}: ${detail}`,
    );
  }

  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const waitForServer = async (baseUrl: string, timeoutMs = 30_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(baseUrl);
      if (res.ok) return;
    } catch {
      // ignore
    }
    await sleep(500);
  }
  throw new Error(`BTCA server did not start within ${timeoutMs}ms`);
};

const sanitize = (value: string) => value.replace(/[^a-z0-9-_]+/gi, "-");

const createServerWorkspace = async (
  model: string,
  provider: string,
  tests: typeof TESTS,
) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = `${BENCH_ROOT}/${sanitize(model)}-${stamp}`;
  const dataDir = `${dir}/data`;

  await Bun.$`mkdir -p ${dir} ${dataDir}`;

  const config = {
    $schema: BTCA_SCHEMA,
    provider,
    model,
    dataDirectory: "./data",
    resources: uniqueResources(tests),
  };

  await Bun.write(`${dir}/btca.config.jsonc`, JSON.stringify(config, null, 2));

  return dir;
};

const collectStderr = (proc: ReturnType<typeof Bun.spawn>) => {
  const chunks: string[] = [];
  const stderr = proc.stderr;
  if (!stderr || typeof stderr === "number") return () => "";
  const reader = (stderr as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const pump = async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // process exited
    }
  };
  pump();
  return () => chunks.join("");
};

const startBtcaServer = async (cwd?: string) => {
  const btcaBin = Bun.which("btca");
  if (!btcaBin) {
    throw new Error(
      "btca CLI not found in PATH. Install btca to run the bench.",
    );
  }

  const pickPort = () => 4000 + Math.floor(Math.random() * 2000);
  const attempts = 5;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = pickPort();
    const proc = Bun.spawn([btcaBin, "serve", "--port", String(port)], {
      stdout: "pipe",
      stderr: "pipe",
      cwd,
    });

    const baseUrl = `http://localhost:${port}`;
    const getStderr = collectStderr(proc);

    try {
      await waitForServer(baseUrl);
      return { proc, baseUrl, getStderr };
    } catch (error) {
      proc.kill();
      if (attempt === attempts - 1) throw error;
    }
  }

  throw new Error("Unable to start btca server.");
};

const ensureResource = async (baseUrl: string, resource: { name: string }) => {
  const data = await fetchJson(`${baseUrl}/resources`);
  const resources = Array.isArray(data) ? data : (data?.resources ?? []);
  const exists = resources.some(
    (item: { name?: string }) => item.name === resource.name,
  );

  if (!exists) {
    await fetchJson(`${baseUrl}/config/resources`, {
      method: "POST",
      body: JSON.stringify(resource),
    });
  }
};

const setModel = (baseUrl: string, model: string, provider: string) =>
  fetchJson(`${baseUrl}/config/model`, {
    method: "PUT",
    body: JSON.stringify({ provider, model }),
  });

const safeJson = (value: string) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const formatError = (error: unknown) => {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const parseSseEvent = (chunk: string) => {
  const lines = chunk.split("\n").filter(Boolean);
  const eventLine = lines.find((line) => line.startsWith("event:"));
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5));
  const dataText = dataLines.join("\n").trim();
  if (!dataText) return null;
  const data = safeJson(dataText);
  if (!data) return null;
  const type = (data.type ?? eventLine?.slice(6).trim()) as string | undefined;
  return type ? { type, data } : null;
};

const streamQuestion = async (
  baseUrl: string,
  question: string,
  resources: string[],
) => {
  const response = await fetch(`${baseUrl}/question/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question, resources }),
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Stream request failed: ${response.status} ${response.statusText} ${detail}`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoning = "";
  const toolCalls = new Set<string>();
  let toolUpdates = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const event = parseSseEvent(part);
      if (!event) continue;

      if (event.type === "text.delta") text += event.data.delta ?? "";
      if (event.type === "reasoning.delta") reasoning += event.data.delta ?? "";
      if (event.type === "tool.updated") {
        toolUpdates += 1;
        if (event.data.callID) toolCalls.add(event.data.callID as string);
      }
      if (event.type === "done") {
        if (event.data.text) text = event.data.text as string;
      }
      if (event.type === "error") {
        throw new Error(
          `BTCA stream error: ${event.data.message ?? "unknown"}`,
        );
      }
    }
  }

  return {
    text: text.trim(),
    reasoning: reasoning.trim(),
    toolCalls: toolCalls.size,
    toolUpdates,
  };
};

const createJudge = () => {
  const apiKey = process.env.OPENCODE_API_KEY;
  if (!apiKey) throw new Error("OPENCODE_API_KEY is missing from environment.");

  return createAnthropic({
    apiKey,
    baseURL: "https://opencode.ai/zen/v1",
  });
};

const parseJudgeResponse = (raw: string) => {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  const parsed = safeJson(match[0]);
  if (!parsed || typeof parsed.score !== "number") return null;
  return parsed as { score: number; clarity?: number; notes?: string };
};

const judgeAnswer = async (
  judge: ReturnType<typeof createJudge>,
  question: string,
  answer: string,
) => {
  const system = [
    "You are a strict evaluator.",
    "Score usefulness 0-4 based on whether the answer is good enough to implement/solve the problem (0 incorrect, 1 partial, 2 mostly correct, 3 correct and complete, 4 correct and includes precise API names or file references).",
    "Score clarity 0-4 based on how clear and actionable the answer is.",
    'Output JSON only: {"score": number, "clarity": number, "notes": string}.',
  ].join(" ");

  const prompt = `Question:\n${question}\n\nAnswer:\n${answer}\n\nReturn JSON only.`;

  const { text } = await generateText({
    model: judge("claude-haiku-4-5"),
    system,
    prompt,
    temperature: 0,
    maxOutputTokens: 300,
  });

  return { raw: text, parsed: parseJudgeResponse(text) };
};

const runModelBench = async (
  model: string,
  provider: string,
  runs: number,
  judge: ReturnType<typeof createJudge>,
  tests: typeof TESTS,
) => {
  const workspace = await createServerWorkspace(model, provider, tests);
  const server = await startBtcaServer(workspace);

  try {
    await Promise.all(
      uniqueResources(tests).map((resource) =>
        ensureResource(server.baseUrl, resource),
      ),
    );
    await setModel(server.baseUrl, model, provider);

    const records: Array<{
      model: string;
      durationSec: number;
      toolCalls: number;
      score: number | null;
      clarity: number | null;
      failed: boolean;
      recordLine: string;
    }> = [];

    for (const test of tests) {
      for (let run = 1; run <= runs; run += 1) {
        console.log(`Running ${model} ${test.id} (${run}/${runs})...`);

        const startedAt = new Date().toISOString();
        const start = Date.now();
        try {
          const response = await streamQuestion(server.baseUrl, test.question, [
            test.resource.name,
          ]);
          const durationSec =
            Math.round(((Date.now() - start) / 1000) * 100) / 100;

          const judged = await judgeAnswer(judge, test.question, response.text);
          const score = judged.parsed?.score ?? null;
          const clarity = judged.parsed?.clarity ?? null;

          const record = {
            model,
            provider,
            testId: test.id,
            run,
            startedAt,
            durationSec,
            toolCalls: response.toolCalls,
            toolUpdates: response.toolUpdates,
            failedToolCalls: 0,
            turns: 1,
            tokens: { input: null, output: null },
            costUSD: null,
            question: test.question,
            resources: [test.resource.name],
            answer: response.text,
            error: null,
            judge: {
              score,
              clarity,
              notes: judged.parsed?.notes ?? null,
              raw: judged.raw,
              model: "claude-haiku-4-5",
            },
          };

          records.push({
            model,
            durationSec,
            toolCalls: response.toolCalls,
            score,
            clarity,
            failed: false,
            recordLine: JSON.stringify(record),
          });
        } catch (error) {
          const durationSec =
            Math.round(((Date.now() - start) / 1000) * 100) / 100;
          const message = formatError(error);
          const record = {
            model,
            provider,
            testId: test.id,
            run,
            startedAt,
            durationSec,
            toolCalls: 0,
            toolUpdates: 0,
            failedToolCalls: 1,
            turns: 1,
            tokens: { input: null, output: null },
            costUSD: null,
            question: test.question,
            resources: [test.resource.name],
            answer: "",
            error: message,
            judge: {
              score: null,
              clarity: null,
              notes: null,
              raw: "",
              model: "claude-haiku-4-5",
            },
          };

          console.error(`[${model}] ${test.id} run ${run} failed: ${message}`);
          const stderr = server.getStderr();
          if (stderr.trim()) {
            console.error(`[${model}] btca stderr:\n${stderr}`);
          }

          records.push({
            model,
            durationSec,
            toolCalls: 0,
            score: null,
            clarity: null,
            failed: true,
            recordLine: JSON.stringify(record),
          });
        }
      }
    }

    return records;
  } finally {
    server.proc.kill();
  }
};

const buildTimestamp = () => new Date().toISOString().replace(/[:.]/g, "-");

const ensureResultsDir = async () => {
  await Bun.$`mkdir -p results`;
  return "results";
};

const runBench = async () => {
  const args = process.argv.slice(2);
  const runs = parseRuns(args);
  const modelOverride = parseModel(args);
  const entries = modelOverride
    ? MODELS.find((m) => m.model === modelOverride)
      ? MODELS.filter((m) => m.model === modelOverride)
      : [{ model: modelOverride, provider: "opencode" }]
    : MODELS;
  const resultsDir = await ensureResultsDir();
  const resultsPath = `${resultsDir}/bench-results-${buildTimestamp()}.jsonl`;
  const judge = createJudge();

  const modelResults = await Promise.all(
    entries.map(({ model, provider }) =>
      runModelBench(model, provider, runs, judge, TESTS),
    ),
  );

  const records = modelResults.flat();
  const summary = records.map((record) => ({
    testId: record.recordLine ? JSON.parse(record.recordLine).testId : null,
    model: record.model,
    durationSec: record.durationSec,
    toolCalls: record.toolCalls,
    score: record.score,
    clarity: record.clarity,
    failed: record.failed,
  }));

  if (!modelOverride) {
    await Bun.write(
      resultsPath,
      records.length
        ? `${records.map((record) => record.recordLine).join("\n")}\n`
        : "",
    );
  }

  const grouped = summary.reduce(
    (acc, entry) => {
      const key = modelOverride ? (entry.testId ?? "unknown") : entry.model;
      const bucket = acc[key] ?? [];
      bucket.push(entry);
      acc[key] = bucket;
      return acc;
    },
    {} as Record<string, typeof summary>,
  );

  const table = Object.entries(grouped).map(([groupKey, entries]) => {
    const avg = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) /
      Math.max(values.length, 1);
    const scoreValues = entries
      .map((entry) => entry.score)
      .filter((score): score is number => score !== null);
    const clarityValues = entries
      .map((entry) => entry.clarity)
      .filter((clarity): clarity is number => clarity !== null);

    return {
      [modelOverride ? "testId" : "model"]: groupKey,
      avgDurationSec:
        Math.round(avg(entries.map((entry) => entry.durationSec)) * 100) / 100,
      avgToolCalls:
        Math.round(avg(entries.map((entry) => entry.toolCalls)) * 100) / 100,
      avgScore: scoreValues.length
        ? Math.round(avg(scoreValues) * 100) / 100
        : "n/a",
      avgClarity: clarityValues.length
        ? Math.round(avg(clarityValues) * 100) / 100
        : "n/a",
      failedRuns: entries.filter((entry) => entry.failed).length,
    };
  });

  if (modelOverride) {
    console.log(`\nResults for ${modelOverride}`);
  } else {
    console.log("\nSummary (avg per model)");
  }
  console.table(table);
  if (!modelOverride) console.log(`\nResults written to ${resultsPath}`);
};

try {
  await runBench();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
