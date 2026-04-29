import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { AIProvider } from "./ai/contracts";
import type { Message } from "./ai/messages";
import { AgentRunner } from "./agent/runner";
import { loadPermissions } from "./permissions";
import { bashTool } from "./tools/bash";
import { authorizeFileEdit, discardFileEdit, editFileTool, previewFileEdit } from "./tools/edit";
import { readFileTool } from "./tools/files";
import { globTool, grepTool } from "./tools/search";
import { ToolRegistry } from "./tools/tool";
import { webFetchTool } from "./tools/webfetch";
import { colorizeDiff, terminalStyle as style } from "./terminal/style";

const SYSTEM_PROMPT = [
  "You are a small, careful coding assistant.",
  "For greetings, explanations, and general questions, answer directly without tools.",
  "Use tools when the user asks you to inspect, create, modify, execute, or fetch something.",
  "Use glob to find file paths and grep to search file contents before reading relevant files.",
  "For file changes, use edit_file so the user can review and approve a diff before it is written.",
  "When no tool is needed, put the answer in a JSON object with an 'answer' string.",
  "Use relative paths for project files.",
].join(" ");

function createTools(): ToolRegistry {
  const tools = new ToolRegistry();
  for (const tool of [bashTool, readFileTool, globTool, grepTool, editFileTool, webFetchTool]) tools.register(tool);
  return tools;
}

function showToolInput(argumentsText: string): string {
  try {
    const input = JSON.parse(argumentsText) as Record<string, unknown>;
    const value = input.command ?? input.path ?? input.url ?? input.query ?? input.pattern;
    return typeof value === "string" ? value : argumentsText;
  } catch {
    return argumentsText;
  }
}

/** Start the terminal application with a provider supplied by the caller. */
export async function runApp(provider: AIProvider): Promise<void> {
  const permissions = await loadPermissions();
  const messages: Message[] = [{ role: "system", content: SYSTEM_PROMPT }];
  const tools = createTools();
  const terminal = createInterface({ input, output });
  const runner = new AgentRunner(provider, tools, {
    async authorizeToolCall(name, argumentsText) {
      const permission = permissions[name] ?? "deny";
      if (permission === "deny") return false;
      if (name === "edit_file") {
        let input: unknown;
        try {
          input = JSON.parse(argumentsText);
          const preview = await previewFileEdit(input);
          console.log(`\n${style.label("EDIT")} ${style.path(preview.path)}\n${colorizeDiff(preview.diff)}`);
          if (permission === "ask") {
            const answer = await terminal.question(`${style.approval("Apply edit?")} ${style.muted("[y/N]")} `);
            if (!["y", "yes"].includes(answer.trim().toLowerCase())) {
              discardFileEdit(input);
              return false;
            }
          }
          authorizeFileEdit(input);
          return true;
        } catch (error) {
          if (input !== undefined) discardFileEdit(input);
          console.error(`\n${style.error("EDIT ERROR")} ${error instanceof Error ? error.message : String(error)}`);
          return false;
        }
      }
      if (permission === "allow") return true;

      const subject = showToolInput(argumentsText);
      console.log(`\n${style.approval(name.toUpperCase())} ${style.path(subject)}`);
      const answer = await terminal.question(`${style.approval("Allow this tool?")} ${style.muted("[y/N]")} `);
      return ["y", "yes"].includes(answer.trim().toLowerCase());
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
