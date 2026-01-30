import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const publicDir = join(projectRoot, "public");
const resultsDir = join(projectRoot, "results");
const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_TTL_MS = 60 * 60 * 1000;

const modelsDevCache: { fetchedAt: number; data: unknown | null } = {
  fetchedAt: 0,
  data: null,
};

const json = (data: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(data, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
    ...init,
  });

const contentType = (path: string) => {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "text/plain; charset=utf-8";
};

const listResultFiles = async () => {
  const entries = await readdir(resultsDir).catch(() => [] as string[]);

  const files = await Promise.all(
    entries
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => {
        const fullPath = join(resultsDir, name);
        const info = await stat(fullPath).catch(() => null);
        if (!info) return null;

        return {
          name,
          path: fullPath,
          size: info.size,
          mtime: info.mtime.toISOString(),
        };
      }),
  );

  return files
    .filter((file): file is NonNullable<typeof file> => Boolean(file))
    .sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime());
};

const pickFile = async (name?: string | null) => {
  const files = await listResultFiles();
  if (!files.length) return null;
  if (!name) return files[0];
  return files.find((file) => file.name === name) ?? files[0];
};

const parseJsonl = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [] as unknown[];
      }
    });

const normalize = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "");

const modelVariants = (value: string) => {
  const base = normalize(value);
  const variants = new Set([base]);
  if (base.endsWith("codex")) variants.add(base.replace(/codex$/, ""));
  if (base.endsWith("preview")) variants.add(base.replace(/preview$/, ""));
  if (base.endsWith("latest")) variants.add(base.replace(/latest$/, ""));
  return Array.from(variants).filter(Boolean);
};

const vendorPriority = [
  "openai",
  "anthropic",
  "google",
  "moonshotai",
  "moonshotai-cn",
  "minimax",
  "zai",
  "qwen",
  "alibaba",
  "302ai",
  "abacus",
  "requesty",
  "openrouter",
  "vercel",
  "github-copilot",
  "firmware",
];

const vendorBoost = (vendor?: string) => {
  const index = vendor ? vendorPriority.indexOf(vendor) : -1;
  if (index === -1) return 0;
  return Math.max(0, vendorPriority.length - index);
};

const hasCost = (cost: Record<string, unknown> | null) => {
  if (!cost) return false;
  const input =
    typeof cost.input === "number" && Number.isFinite(cost.input)
      ? cost.input
      : 0;
  const output =
    typeof cost.output === "number" && Number.isFinite(cost.output)
      ? cost.output
      : 0;
  return input > 0 || output > 0;
};

const flattenModels = (data: Record<string, unknown>) =>
  Object.entries(data).flatMap(([provider, value]) => {
    const models =
      (value as { models?: Record<string, unknown> })?.models ?? {};
    return Object.entries(models).map(([key, model]) => {
      const entry = model as {
        id?: string;
        name?: string;
        cost?: Record<string, unknown>;
      };
      const id = entry.id ?? key;
      const vendor = id.includes("/") ? id.split("/")[0] : provider;
      return {
        provider,
        vendor,
        id,
        name: entry.name ?? id,
        cost: entry.cost ?? null,
        idKey: normalize(id),
        nameKey: normalize(entry.name ?? id),
      };
    });
  });

const scoreEntry = (
  entry: ReturnType<typeof flattenModels>[number],
  targets: string[],
) => {
  let score = 0;
  for (const target of targets) {
    if (entry.idKey === target || entry.nameKey === target) score = 100;
    else if (entry.idKey.endsWith(target) || entry.nameKey.endsWith(target))
      score = Math.max(score, 90);
    else if (entry.idKey.includes(target) || entry.nameKey.includes(target))
      score = Math.max(score, 70);
  }

  if (score === 0) return 0;
  if (hasCost(entry.cost)) score += 5;
  score += vendorBoost(entry.vendor);
  return score;
};

const resolvePricing = (
  models: string[],
  entries: ReturnType<typeof flattenModels>,
) => {
  const pricing: Record<string, unknown> = {};

  for (const model of models) {
    const targets = modelVariants(model);
    const ranked = entries
      .map((entry) => ({ entry, score: scoreEntry(entry, targets) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    const best = ranked[0]?.entry;
    if (!best) continue;

    const input =
      typeof best.cost?.input === "number" && Number.isFinite(best.cost.input)
        ? best.cost.input
        : 0;
    const output =
      typeof best.cost?.output === "number" && Number.isFinite(best.cost.output)
        ? best.cost.output
        : 0;
    const cacheRead =
      typeof best.cost?.cache_read === "number" &&
      Number.isFinite(best.cost.cache_read)
        ? best.cost.cache_read
        : null;
    const cacheWrite =
      typeof best.cost?.cache_write === "number" &&
      Number.isFinite(best.cost.cache_write)
        ? best.cost.cache_write
        : null;

    pricing[model] = {
      id: best.id,
      name: best.name,
      vendor: best.vendor,
      provider: best.provider,
      input,
      output,
      cacheRead,
      cacheWrite,
      total: input + output,
    };
  }

  return pricing;
};

const preferProvider = (
  entries: ReturnType<typeof flattenModels>,
  provider: string,
) => {
  const preferred = entries.filter((entry) => entry.provider === provider);
  return preferred.length ? preferred : entries;
};

const fetchModelsDev = async () => {
  const now = Date.now();
  if (modelsDevCache.data && now - modelsDevCache.fetchedAt < MODELS_DEV_TTL_MS)
    return modelsDevCache.data;

  const response = await fetch(MODELS_DEV_URL).catch(() => null);
  if (!response || !response.ok) return modelsDevCache.data;
  const data = await response.json().catch(() => null);
  if (!data) return modelsDevCache.data;
  modelsDevCache.data = data;
  modelsDevCache.fetchedAt = now;
  return data;
};

const addPricing = async (records: unknown[]) => {
  const modelNames = Array.from(
    new Set(
      records
        .map((record) => (record as { model?: string }).model)
        .filter((value): value is string => Boolean(value)),
    ),
  );

  const data = await fetchModelsDev();
  if (!data)
    return {
      pricing: {},
      pricingMeta: { source: MODELS_DEV_URL, fetchedAt: null },
    };

  const entries = flattenModels(data as Record<string, unknown>);
  const opencodeEntries = preferProvider(entries, "opencode");
  const pricing = resolvePricing(modelNames, opencodeEntries);

  return {
    pricing,
    pricingMeta: {
      source: MODELS_DEV_URL,
      provider: opencodeEntries.length ? "opencode" : "mixed",
      fetchedAt: modelsDevCache.fetchedAt
        ? new Date(modelsDevCache.fetchedAt).toISOString()
        : null,
    },
  };
};

const readResults = async (name?: string | null) => {
  const file = await pickFile(name);
  if (!file) return null;

  const text = await Bun.file(file.path).text();
  const records = parseJsonl(text);
  const pricing = await addPricing(records);

  return {
    file: file.name,
    size: file.size,
    mtime: file.mtime,
    records,
    ...pricing,
  };
};

const serveStatic = async (pathname: string) => {
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const target = join(publicDir, requestPath);
  const file = Bun.file(target);
  if (!(await file.exists())) return null;
  return new Response(file, {
    headers: { "content-type": contentType(target) },
  });
};

const serveResultsFile = async (pathname: string) => {
  if (!pathname.startsWith("/results/")) return null;
  const name = pathname.replace("/results/", "");
  if (!name || name.includes("..")) return null;
  const file = await pickFile(name);
  if (!file || file.name !== name) return null;

  return new Response(Bun.file(file.path), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch: async (request) => {
    const { pathname, searchParams } = new URL(request.url);

    if (pathname === "/api/files") {
      const files = await listResultFiles();
      return json({ files });
    }

    if (pathname === "/api/results") {
      const file = searchParams.get("file");
      const results = await readResults(file);
      if (!results)
        return json({ error: "No results found." }, { status: 404 });
      return json(results);
    }

    if (pathname.startsWith("/results/")) {
      const response = await serveResultsFile(pathname);
      if (response) return response;
    }

    const staticResponse = await serveStatic(pathname);
    if (staticResponse) return staticResponse;

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Bench UI running on http://localhost:${server.port}`);
