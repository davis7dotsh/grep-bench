import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";

const QUESTION =
  "How do I do progressive enhancement with SvelteKit form actions using the form remote function? Provide a short explanation and a minimal code example.";
const RESOURCE_NAME = "svelte";
const RESOURCE_CONFIG = {
  type: "git",
  name: RESOURCE_NAME,
  url: "https://github.com/sveltejs/svelte.dev",
  branch: "main",
};
const MODELS = [
  "gpt-5.2-codex",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "gemini-3-flash",
  "minimax-m2.1",
  "glm-4.7",
  "kimi-k2.5",
  "qwen3-coder",
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

const unique = <T>(values: T[]) => Array.from(new Set(values));

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

const createServerWorkspace = async (model: string) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = `${BENCH_ROOT}/${sanitize(model)}-${stamp}`;
  const dataDir = `${dir}/data`;

  await Bun.$`mkdir -p ${dir} ${dataDir}`;

  const config = {
    $schema: BTCA_SCHEMA,
    provider: "opencode",
    model,
    dataDirectory: "./data",
    resources: [RESOURCE_CONFIG],
  };

  await Bun.write(`${dir}/btca.config.jsonc`, JSON.stringify(config, null, 2));

  return dir;
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

    try {
      await waitForServer(baseUrl);
      return { proc, baseUrl };
    } catch (error) {
      proc.kill();
      if (attempt === attempts - 1) throw error;
    }
  }

  throw new Error("Unable to start btca server.");
};

const ensureResource = async (baseUrl: string) => {
  const data = await fetchJson(`${baseUrl}/resources`);
  const resources = Array.isArray(data) ? data : (data?.resources ?? []);
  const exists = resources.some(
    (resource: { name?: string }) => resource.name === RESOURCE_NAME,
  );

  if (!exists) {
    await fetchJson(`${baseUrl}/config/resources`, {
      method: "POST",
      body: JSON.stringify(RESOURCE_CONFIG),
    });
  }
};

const setModel = (baseUrl: string, model: string) =>
  fetchJson(`${baseUrl}/config/model`, {
    method: "PUT",
    body: JSON.stringify({ provider: "opencode", model }),
  });

const safeJson = (value: string) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
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
  return parsed as { score: number; notes?: string };
};

const judgeAnswer = async (
  judge: ReturnType<typeof createJudge>,
  question: string,
  answer: string,
) => {
  const system = [
    "You are a strict evaluator.",
    "Score accuracy 0-4 using this rubric: 0 incorrect, 1 partial, 2 mostly correct, 3 correct and complete, 4 correct and cites precise API names or file references.",
    'Output JSON only: {"score": number, "notes": string}.',
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
  runs: number,
  judge: ReturnType<typeof createJudge>,
) => {
  const workspace = await createServerWorkspace(model);
  const server = await startBtcaServer(workspace);

  try {
    await ensureResource(server.baseUrl);
    await setModel(server.baseUrl, model);

    const records: Array<{
      model: string;
      durationMs: number;
      toolCalls: number;
      score: number | null;
      recordLine: string;
    }> = [];

    for (let run = 1; run <= runs; run += 1) {
      console.log(`Running ${model} (${run}/${runs})...`);

      const startedAt = new Date().toISOString();
      const start = Date.now();
      const response = await streamQuestion(server.baseUrl, QUESTION, [
        RESOURCE_NAME,
      ]);
      const durationMs = Date.now() - start;

      const judged = await judgeAnswer(judge, QUESTION, response.text);
      const score = judged.parsed?.score ?? null;

      const record = {
        model,
        run,
        startedAt,
        durationMs,
        toolCalls: response.toolCalls,
        toolUpdates: response.toolUpdates,
        turns: 1,
        tokens: { input: null, output: null },
        costUSD: null,
        question: QUESTION,
        resources: [RESOURCE_NAME],
        answer: response.text,
        judge: {
          score,
          notes: judged.parsed?.notes ?? null,
          raw: judged.raw,
          model: "claude-haiku-4-5",
        },
      };

      records.push({
        model,
        durationMs,
        toolCalls: response.toolCalls,
        score,
        recordLine: JSON.stringify(record),
      });
    }

    return records;
  } finally {
    server.proc.kill();
  }
};

const runBench = async () => {
  const runs = parseRuns(process.argv.slice(2));
  const models = unique(MODELS);
  const resultsPath = "bench-results.jsonl";
  const judge = createJudge();

  const modelResults = await Promise.all(
    models.map((model) => runModelBench(model, runs, judge)),
  );

  const records = modelResults.flat();
  const summary = records.map((record) => ({
    model: record.model,
    durationMs: record.durationMs,
    toolCalls: record.toolCalls,
    score: record.score,
  }));

  await Bun.write(
    resultsPath,
    records.length
      ? `${records.map((record) => record.recordLine).join("\n")}\n`
      : "",
  );

  console.log("\nSummary (avg per model)");
  const grouped = summary.reduce(
    (acc, entry) => {
      const bucket = acc[entry.model] ?? [];
      bucket.push(entry);
      acc[entry.model] = bucket;
      return acc;
    },
    {} as Record<string, typeof summary>,
  );

  const table = Object.entries(grouped).map(([model, entries]) => {
    const avg = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) /
      Math.max(values.length, 1);
    const scoreValues = entries
      .map((entry) => entry.score)
      .filter((score): score is number => score !== null);

    return {
      model,
      avgDurationMs: Math.round(avg(entries.map((entry) => entry.durationMs))),
      avgToolCalls:
        Math.round(avg(entries.map((entry) => entry.toolCalls)) * 100) / 100,
      avgScore: scoreValues.length
        ? Math.round(avg(scoreValues) * 100) / 100
        : "n/a",
    };
  });

  console.table(table);
  console.log(`\nResults written to ${resultsPath}`);
};

await runBench();
