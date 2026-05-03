import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { listResultFiles, readResults } from "../src/results-api";

const projectRoot = process.cwd();
const outDir = join(projectRoot, "dist");
const templatePath = join(projectRoot, "public", "index.html");
const outPath = join(outDir, "index.html");

const escapeJsonForHtml = (value: unknown) =>
  JSON.stringify(value).replace(/</g, "\\u003c");

const files = (await listResultFiles()).map(({ path, ...file }) => file);
const resultsEntries = await Promise.all(
  files.map(async (file) => [file.name, await readResults(file.name)] as const),
);

const data = {
  files,
  resultsByFile: Object.fromEntries(resultsEntries),
};

const template = await Bun.file(templatePath).text();
const dataScript = `<script id="grep-bench-data" type="application/json">${escapeJsonForHtml(data)}</script>`;
const html = template.replace(
  '<script type="module">',
  `${dataScript}\n    <script type="module">`,
);

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await Bun.write(outPath, html);

console.log(`Built static results site to ${outPath}`);
