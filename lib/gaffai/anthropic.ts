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
// Opus 5.5 always thinks; its thinking blocks come back in content and are
// passed back untouched within the same question's tool loop.
export interface AnthropicThinkingBlock {
  type: "thinking" | "redacted_thinking" | "fallback";
  [key: string]: unknown;
}
export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock | AnthropicThinkingBlock;

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
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "refusal" | "pause_turn" | null;
}

// Opus 5.5 (2026-09-30), up from Haiku 4.5, which kept missing bookings and
// giving up on "who should we message" questions. Medium effort keeps each
// round quick; thinking is always on for this model.
const MODEL = "claude-opus-5-5";
const MAX_TOKENS = 16000;
const EFFORT = "medium";
const REQUEST_TIMEOUT_MS = 55000;

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
        // If the model declines, the API reruns the request on a fallback model.
        "anthropic-beta": "server-side-fallback-2026-07-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        output_config: { effort: EFFORT },
        fallbacks: "default",
        // Caches tools + system + history, so each extra tool round of the
        // same question costs a fraction of the first.
        cache_control: { type: "ephemeral" },
        system,
        messages,
        tools,
      }),
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
