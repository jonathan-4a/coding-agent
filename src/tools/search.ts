import { z } from "zod";
import type { Tool } from "./tool";

const root = Bun.env.AGENT_ROOT ?? process.cwd();
const MAX_OUTPUT_BYTES = 20_000;
const SEARCH_TIMEOUT_MS = 15_000;
const globInput = z.object({ pattern: z.string().min(1) }).strict();
const grepInput = z.object({ query: z.string().min(1), pattern: z.string().min(1).optional() }).strict();

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  onLimit: () => void,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_OUTPUT_BYTES - bytes;
      if (value.byteLength > remaining) {
        if (remaining > 0) text += decoder.decode(value.subarray(0, remaining), { stream: true });
        text += decoder.decode();
        truncated = true;
        onLimit();
        await reader.cancel();
        break;
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  if (!truncated) text += decoder.decode();
  return { text, truncated };
}

async function runRg(args: string[]): Promise<string> {
  const process = Bun.spawn(["rg", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  let stoppedFor: "timeout" | "output limit" | undefined;
  const stop = (reason: "timeout" | "output limit") => {
    if (stoppedFor) return;
    stoppedFor = reason;
    process.kill("SIGKILL");
  };
  const timeout = setTimeout(() => stop("timeout"), SEARCH_TIMEOUT_MS);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(process.stdout, () => stop("output limit")),
      readBounded(process.stderr, () => stop("output limit")),
      process.exited,
    ]);
    if (stoppedFor === "timeout") throw new Error(`Search timed out after ${SEARCH_TIMEOUT_MS / 1000} seconds.`);
    if (exitCode > 1) throw new Error(stderr.text.trim() || `rg exited with code ${exitCode}.`);
    if (exitCode === 1 && !stdout.text) return "No matches.";
    const notice = stoppedFor === "output limit" || stdout.truncated || stderr.truncated
      ? `\nOutput truncated at ${MAX_OUTPUT_BYTES} bytes.`
      : "";
    return `${stdout.text.trimEnd() || "No matches."}${notice}`;
  } finally {
    clearTimeout(timeout);
  }
}

export const globTool: Tool = {
  definition: {
    name: "glob",
    description: "List project files matching a glob pattern, such as src/**/*.ts. Respects .gitignore.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string", description: "File pattern relative to the project root." } },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  async execute(input) {
    const { pattern } = globInput.parse(input);
    return runRg(["--files", "--glob", pattern, "--"]);
  },
};

export const grepTool: Tool = {
  definition: {
    name: "grep",
    description: "Search project file contents with a regular expression. Respects .gitignore and reports file paths and line numbers.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Regular expression to search for." },
        pattern: { type: "string", description: "Optional glob pattern limiting which files are searched." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  async execute(input) {
    const { query, pattern } = grepInput.parse(input);
    const args = ["--line-number", "--no-heading", "--color", "never", "--smart-case"];
    if (pattern) args.push("--glob", pattern);
    args.push("--", query);
    return runRg(args);
  },
};
