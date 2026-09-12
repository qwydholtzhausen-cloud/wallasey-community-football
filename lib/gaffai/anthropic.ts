// Hand-rolled fetch wrapper for the Anthropic Messages API, matching this
// codebase's existing external-API style (lib/monzo.ts) rather than
// pulling in the SDK - this is one endpoint, no streaming, no batches.

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}
export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface AnthropicResponse {
  id: string;
  role: "assistant";
  content: AnthropicContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null;
}

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 2048;
const REQUEST_TIMEOUT_MS = 20000;

export async function callClaude(messages: AnthropicMessage[], tools: AnthropicToolDef[], system: string): Promise<AnthropicResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, messages, tools }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(`Anthropic API error ${res.status}: ${bodyText.slice(0, 300)}`);
    }
    return (await res.json()) as AnthropicResponse;
  } finally {
    clearTimeout(timeout);
  }
}
