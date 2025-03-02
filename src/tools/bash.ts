import { z } from "zod";
import type { Tool } from "./tool";

const inputSchema = z.object({ command: z.string().min(1) });
const root = Bun.env.AGENT_ROOT ?? process.cwd();
const MAX_OUTPUT_BYTES = 100_000;
const COMMAND_TIMEOUT_MS = 30_000;

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  onLimit: () => void,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_OUTPUT_BYTES - bytes;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        bytes += Math.max(remaining, 0);
        truncated = true;
        onLimit();
        await reader.cancel();
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(combined), truncated };
}

export const bashTool: Tool = {
  definition: {
    name: "bash",
    description: "Run a shell command with the project root as its working directory.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  async execute(input) {
    const { command } = inputSchema.parse(input);
    const proc = Bun.spawn(["sh", "-c", command], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    let stoppedFor: "timeout" | "output limit" | undefined;
    const stop = (reason: "timeout" | "output limit") => {
      if (stoppedFor) return;
      stoppedFor = reason;
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    };
    const timeout = setTimeout(() => stop("timeout"), COMMAND_TIMEOUT_MS);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        readLimited(proc.stdout, () => stop("output limit")),
        readLimited(proc.stderr, () => stop("output limit")),
        proc.exited,
      ]);
      const output = [stdout.text.trim(), stderr.text.trim() ? `stderr:\n${stderr.text.trim()}` : ""]
        .filter(Boolean)
        .join("\n");
      const notices = [
        stoppedFor === "timeout" ? `command timed out after ${COMMAND_TIMEOUT_MS / 1000} seconds` : "",
        stoppedFor === "output limit" || stdout.truncated || stderr.truncated
          ? `output truncated at ${MAX_OUTPUT_BYTES} bytes per stream`
          : "",
      ].filter(Boolean);
      return [`exit code: ${exitCode}`, ...notices, output || "(no output)"].join("\n");
    } finally {
      clearTimeout(timeout);
    }
  },
};
