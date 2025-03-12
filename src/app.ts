import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { AIProvider } from "./ai/contracts";
import type { Message } from "./ai/messages";
import { AgentRunner } from "./agent/runner";
import { bashTool } from "./tools/bash";
import { readFileTool } from "./tools/files";
import { ToolRegistry } from "./tools/tool";
import { webFetchTool } from "./tools/webfetch";

const SYSTEM_PROMPT = [
  "You are a small, careful coding assistant.",
  "For greetings, explanations, and general questions, answer directly without tools.",
  "Use tools when the user asks you to inspect, create, modify, execute, or fetch something.",
  "When no tool is needed, put the answer in a JSON object with an 'answer' string.",
  "Use relative paths for project files.",
].join(" ");

function createTools(): ToolRegistry {
  const tools = new ToolRegistry();
  for (const tool of [bashTool, readFileTool, webFetchTool]) tools.register(tool);
  return tools;
}

function showToolInput(argumentsText: string): string {
  try {
    const input = JSON.parse(argumentsText) as Record<string, unknown>;
    const value = input.command ?? input.path ?? input.url;
    return typeof value === "string" ? value : argumentsText;
  } catch {
    return argumentsText;
  }
}

/** Start the terminal application with a provider supplied by the caller. */
export async function runApp(provider: AIProvider): Promise<void> {
  const messages: Message[] = [{ role: "system", content: SYSTEM_PROMPT }];
  const tools = createTools();
  const terminal = createInterface({ input, output });
  const runner = new AgentRunner(provider, tools, {
    async authorizeToolCall(name, argumentsText) {
      if (name !== "bash") return true;
      const command = showToolInput(argumentsText);
      console.log(`\nAgent wants to run:\n${command}`);
      const answer = await terminal.question("Allow this command? [y/N] ");
      return ["y", "yes"].includes(answer.trim().toLowerCase());
    },
    onToolStart(name, argumentsText) {
      console.log(`\n→ ${name}: ${showToolInput(argumentsText)}`);
    },
    onToolEnd(name) {
      console.log(`✓ ${name} finished`);
    },
  });

  console.log(`${provider.label()} is ready.`);
  console.log("Coding Agent is ready. Type a request, or press Ctrl+C to exit.");

  for (;;) {
    const question = (await terminal.question("\n> ")).trim();
    if (!question) continue;

    try {
      console.log(`\n${await runner.run(messages, question)}`);
    } catch (error) {
      console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
