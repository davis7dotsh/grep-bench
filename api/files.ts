import { json, listResultFiles } from "./_results.ts";

export default {
  async fetch() {
    const files = await listResultFiles();
    return json({ files });
  },
};
