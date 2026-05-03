import { json, readResults } from "./_results.ts";

export default {
  async fetch(request: Request) {
    const { searchParams } = new URL(request.url);
    const results = await readResults(searchParams.get("file"));
    if (!results) return json({ error: "No results found." }, { status: 404 });
    return json(results);
  },
};
