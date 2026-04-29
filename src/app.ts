import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { AIProvider } from "./ai/contracts";
import type { Message } from "./ai/messages";
import { AgentRunner } from "./agent/runner";
import { bashTool } from "./tools/bash";
import { authorizeFileEdit, discardFileEdit, editFileTool, previewFileEdit } from "./tools/edit";
import { readFileTool } from "./tools/files";
import { ToolRegistry } from "./tools/tool";
import { webFetchTool } from "./tools/webfetch";
import { colorizeDiff, terminalStyle as style } from "./terminal/style";

const SYSTEM_PROMPT = [
  "You are a small, careful coding assistant.",
  "For greetings, explanations, and general questions, answer directly without tools.",
  "Use tools when the user asks you to inspect, create, modify, execute, or fetch something.",
  "For file changes, use edit_file so the user can review and approve a diff before it is written.",
  "When no tool is needed, put the answer in a JSON object with an 'answer' string.",
  "Use relative paths for project files.",
].join(" ");

function createTools(): ToolRegistry {
  const tools = new ToolRegistry();
  for (const tool of [bashTool, readFileTool, editFileTool, webFetchTool]) tools.register(tool);
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
      if (name === "bash") {
        const command = showToolInput(argumentsText);
        console.log(`\n${style.approval("COMMAND")} ${style.path(command)}`);
        const answer = await terminal.question(`${style.approval("Run command?")} ${style.muted("[y/N]")} `);
        return ["y", "yes"].includes(answer.trim().toLowerCase());
      }
      if (name === "edit_file") {
        let input: unknown;
        try {
          input = JSON.parse(argumentsText);
          const preview = await previewFileEdit(input);
          console.log(`\n${style.approval("EDIT")} ${style.path(preview.path)}\n${colorizeDiff(preview.diff)}`);
          const answer = await terminal.question(`${style.approval("Apply edit?")} ${style.muted("[y/N]")} `);
          const approved = ["y", "yes"].includes(answer.trim().toLowerCase());
          if (approved) authorizeFileEdit(input);
          else discardFileEdit(input);
          return approved;
        } catch (error) {
          if (input !== undefined) discardFileEdit(input);
          console.error(`\n${style.error("EDIT ERROR")} ${error instanceof Error ? error.message : String(error)}`);
          return false;
        }
      }
      return true;
    },
    onToolStart(name) {
      const action = name === "edit_file" ? "APPLYING" : "RUNNING";
      console.log(`\n${style.label(action)} ${style.muted(name)}`);
    },
    onToolEnd(name) {
      console.log(`${style.success("DONE")} ${style.muted(name)}`);
    },
  });

  console.log(`${style.success("READY")} ${provider.label()}`);
  console.log(`${style.muted("Coding Agent · Ctrl+C to exit")}`);

  for (;;) {
    const question = (await terminal.question(`\n${style.label("User")} ${style.prompt("> ")}`)).trim();
    if (!question) continue;

    try {
      const answer = await runner.run(messages, question);
      console.log(`\n${style.label("Agent")}\n${answer}`);
    } catch (error) {
      console.error(`\n${style.error("ERROR")} ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
