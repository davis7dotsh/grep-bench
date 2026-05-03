import { json, readResults } from "../src/results-api.ts";

export default async function handler(request: Request) {
  const { searchParams } = new URL(request.url);
  const results = await readResults(searchParams.get("file"));
  if (!results) return json({ error: "No results found." }, { status: 404 });
  return json(results);
}
