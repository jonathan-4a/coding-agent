import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { Tool } from "./tool";

const root = resolve(Bun.env.AGENT_ROOT ?? process.cwd());
const MAX_FILE_BYTES = 1_000_000;
const MAX_PREVIEW_CHARS = 12_000;
const inputSchema = z.object({ path: z.string().min(1), content: z.string() });

interface EditPlan {
  path: string;
  relativePath: string;
  content: string;
  original: string | null;
  authorized: boolean;
}

const pendingEdits = new Map<string, EditPlan>();

function keyFor(path: string, content: string): string {
  return JSON.stringify([path, content]);
}

function isInside(rootPath: string, targetPath: string): boolean {
  const relativeTarget = relative(rootPath, targetPath);
  return relativeTarget !== ".." && !relativeTarget.startsWith(`..${sep}`) && !isAbsolute(relativeTarget);
}

async function getTarget(path: string): Promise<{ absolutePath: string; relativePath: string; exists: boolean }> {
  if (isAbsolute(path)) throw new Error("Use a relative path inside the project root.");

  const realRoot = await realpath(root);
  const requestedPath = resolve(realRoot, path);
  if (!isInside(realRoot, requestedPath) || requestedPath === realRoot) {
    throw new Error("Path is outside the project root or names the project root itself.");
  }

  try {
    await lstat(requestedPath);
    const absolutePath = await realpath(requestedPath);
    if (!isInside(realRoot, absolutePath)) throw new Error("Path is outside the project root.");
    return { absolutePath, relativePath: relative(realRoot, absolutePath), exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const parentPath = await realpath(resolve(requestedPath, ".."));
  if (!isInside(realRoot, parentPath)) throw new Error("Path is outside the project root.");
  const absolutePath = resolve(parentPath, basename(requestedPath));
  return { absolutePath, relativePath: relative(realRoot, absolutePath), exists: false };
}

async function readTextFile(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Only regular text files can be edited.");
  if (info.size > MAX_FILE_BYTES) throw new Error(`Files larger than ${MAX_FILE_BYTES} bytes cannot be edited.`);
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`Files larger than ${MAX_FILE_BYTES} bytes cannot be edited.`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("The target file is not valid UTF-8 text.");
  }
}

function lines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

function createPreview(path: string, original: string | null, content: string): string {
  const oldLines = lines(original ?? "");
  const newLines = lines(content);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++;

  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix);
  const newChanged = newLines.slice(prefix, newLines.length - suffix);
  if (oldChanged.length === 0 && newChanged.length === 0) return `No changes proposed for ${path}.`;

  const beforeStart = Math.max(0, prefix - 3);
  const before = oldLines.slice(beforeStart, prefix);
  const after = suffix ? oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + 3) : [];
  const oldCount = before.length + oldChanged.length + after.length;
  const newCount = before.length + newChanged.length + after.length;
  const oldStart = oldCount === 0 ? 0 : beforeStart + 1;
  const newStart = newCount === 0 ? 0 : beforeStart + 1;

  const diff = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...before.map((line) => ` ${line}`),
    ...oldChanged.map((line) => `-${line}`),
    ...newChanged.map((line) => `+${line}`),
    ...after.map((line) => ` ${line}`),
  ].join("\n");
  if (diff.length <= MAX_PREVIEW_CHARS) return diff;
  return `${diff.slice(0, MAX_PREVIEW_CHARS)}\n… diff preview truncated at ${MAX_PREVIEW_CHARS} characters`;
}

/** Build and retain the exact version shown to the user before approval. */
export async function previewFileEdit(input: unknown): Promise<{ path: string; diff: string }> {
  const parsed = inputSchema.parse(input);
  if (new TextEncoder().encode(parsed.content).byteLength > MAX_FILE_BYTES) {
    throw new Error(`New file content exceeds ${MAX_FILE_BYTES} bytes.`);
  }

  const target = await getTarget(parsed.path);
  const original = target.exists ? await readTextFile(target.absolutePath) : null;
  const plan: EditPlan = {
    path: target.absolutePath,
    relativePath: target.relativePath,
    content: parsed.content,
    original,
    authorized: false,
  };
  pendingEdits.set(keyFor(parsed.path, parsed.content), plan);
  return { path: target.relativePath, diff: createPreview(target.relativePath, original, parsed.content) };
}

export function authorizeFileEdit(input: unknown): void {
  const { path, content } = inputSchema.parse(input);
  const plan = pendingEdits.get(keyFor(path, content));
  if (!plan) throw new Error("No matching file edit preview is awaiting approval.");
  plan.authorized = true;
}

export function discardFileEdit(input: unknown): void {
  const parsed = inputSchema.safeParse(input);
  if (parsed.success) pendingEdits.delete(keyFor(parsed.data.path, parsed.data.content));
}

export const editFileTool: Tool = {
  definition: {
    name: "edit_file",
    description: "Propose replacement UTF-8 text for a file inside the project root. The user must approve the displayed diff before it is written. Use read first when you need the current file contents.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path inside the project root." },
        content: { type: "string", description: "Complete replacement contents for the file." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  async execute(input) {
    const { path, content } = inputSchema.parse(input);
    const key = keyFor(path, content);
    const plan = pendingEdits.get(key);
    pendingEdits.delete(key);
    if (!plan?.authorized) throw new Error("File edit was not approved.");

    const target = await getTarget(path);
    if (target.absolutePath !== plan.path || target.exists !== (plan.original !== null)) {
      throw new Error("The target changed after the preview. Request a fresh edit before writing.");
    }
    const current = target.exists ? await readTextFile(target.absolutePath) : null;
    if (current !== plan.original) throw new Error("The target changed after the preview. Request a fresh edit before writing.");

    if (current === content) return `No changes needed for ${target.relativePath}.`;
    if (target.exists) {
      await writeFile(target.absolutePath, content, "utf8");
    } else {
      await writeFile(target.absolutePath, content, { encoding: "utf8", flag: "wx" });
    }
    return `Updated ${target.relativePath}.`;
  },
};
