import type { Message } from "../ai/messages";
import type { AIProvider } from "../ai/contracts";
import { ToolRegistry } from "../tools/tool";

const MAX_TURNS = 20;

export interface AgentEvents {
  authorizeToolCall?: (name: string, argumentsText: string) => Promise<boolean>;
  onToolStart?: (name: string, argumentsText: string) => void;
  onToolEnd?: (name: string) => void;
}

function displayAnswer(text: string | null): string {
  if (!text) return "(The model returned no text.)";
  try {
    const value = JSON.parse(text) as { answer?: unknown };
    if (typeof value.answer === "string") return value.answer;
  } catch {
    // Some compatible models may return ordinary text despite the JSON hint.
  }
  return text;
}

export class AgentRunner {
  constructor(
    private readonly provider: AIProvider,
    private readonly tools: ToolRegistry,
    private readonly events: AgentEvents = {},
  ) {}

  async run(messages: Message[], question: string, allowedTools?: readonly string[]): Promise<string> {
    messages.push({ role: "user", content: question });

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // One provider call is one model turn. The model either answers or asks
      // for one or more local tools.
      const reply = await this.provider.complete({
        messages,
        tools: this.tools.definitions().filter((tool) => !allowedTools || allowedTools.includes(tool.name)),
        signal: new AbortController().signal,
      });
      messages.push({
        role: "assistant",
        content: reply.text,
        ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}),
      });

      if (!reply.toolCalls.length) return displayAnswer(reply.text);

      // Execute every requested call, append each result, and let the model
      // continue with the updated conversation on the next loop iteration.
      for (const call of reply.toolCalls) {
        let input: unknown;
        try {
          input = JSON.parse(call.arguments);
        } catch {
          input = null;
        }
        let result: string;
        if (!this.events.authorizeToolCall) {
          result = "Tool execution was denied because no authorization handler is configured.";
        } else if (!(await this.events.authorizeToolCall(call.name, call.arguments))) {
          result = "The user denied permission. The tool was not run.";
        } else {
          this.events.onToolStart?.(call.name, call.arguments);
          result = await this.tools.execute(call.name, input);
          this.events.onToolEnd?.(call.name);
        }
        messages.push({ role: "tool", content: result, tool_call_id: call.id });
      }
    }

    throw new Error(`Stopped after ${MAX_TURNS} tool turns.`);
  }
}
