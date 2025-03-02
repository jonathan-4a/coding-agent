import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { Tool } from "./tool";

const root = resolve(Bun.env.AGENT_ROOT ?? process.cwd());
const inputSchema = z.object({ path: z.string().min(1) });

async function safePath(input: string): Promise<string> {
  if (isAbsolute(input)) throw new Error("Use a relative path inside the project root.");
  const path = resolve(root, input);
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(path)]);
  const relativeTarget = relative(realRoot, realTarget);
  if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
    throw new Error("Path is outside the project root.");
  }
  return realTarget;
}

export const readFileTool: Tool = {
  definition: {
    name: "read",
    description: "Read a UTF-8 text file inside the project root.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  async execute(input) {
    const { path } = inputSchema.parse(input);
    return await readFile(await safePath(path), "utf8");
  },
};
