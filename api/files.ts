import { json, listResultFiles } from "../src/results-api.ts";

export default async function handler() {
  const files = await listResultFiles();
  return json({ files });
}
