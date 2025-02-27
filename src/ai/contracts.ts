import type { Message, ToolCall } from "./messages";

/** A provider-neutral description of a tool available to the model. */
export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** The small request shared by the agent runtime and every provider. */
export interface ProviderRequest {
  messages: Message[];
  tools: ToolDefinition[];
  signal: AbortSignal;
}

/** The normalized result the agent loop needs from a provider. */
export interface ProviderResponse {
  text: string | null;
  toolCalls: ToolCall[];
}

/** Provider capability required by the agent runtime. */
export interface AIProvider {
  complete(request: ProviderRequest): Promise<ProviderResponse>;
  label(): string;
}
