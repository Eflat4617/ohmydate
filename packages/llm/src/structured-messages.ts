import { structuredSystemPrompt } from './output-contract.js';
import type { LlmCompleteRequest } from './port.js';

/**
 * FU-54: the ONE builder for the chat messages a structured call sends.
 *
 * `OpenAICompatibleLlm` sends exactly these messages (plus
 * `STRICT_JSON_INSTRUCTION` on the single JSON-mode fallback), and `PolicyLlm`
 * computes its spend reservation upper bound from the same output. Before this
 * module the two rebuilt the messages independently (FU-52cR LOW), so a change
 * to the adapter's messages could silently undercut the reservation.
 */

/** Appended to the system message on the single JSON-mode fallback request. */
export const STRICT_JSON_INSTRUCTION =
  '\n\nReturn only a single valid JSON object that matches the requested schema. ' +
  'Do not wrap it in Markdown fences and do not add prose outside the JSON.';

export interface StructuredChatMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

export type StructuredMessageRequest = Pick<
  LlmCompleteRequest,
  'promptId' | 'version' | 'schemaId' | 'input'
>;

/** System message (prompt + generated output contract) and the serialized user input. */
export function buildStructuredMessages(
  request: StructuredMessageRequest,
): readonly [StructuredChatMessage, StructuredChatMessage] {
  const system = structuredSystemPrompt(request.promptId, request.version, request.schemaId);
  const user = JSON.stringify(request.input ?? {}) ?? '{}';
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** The fallback message set: the same messages with the strict JSON instruction appended. */
export function withStrictJsonInstruction(
  messages: readonly StructuredChatMessage[],
): StructuredChatMessage[] {
  return messages.map((message) =>
    message.role === 'system'
      ? { ...message, content: `${message.content}${STRICT_JSON_INSTRUCTION}` }
      : message,
  );
}

const encoder = new TextEncoder();

/** UTF-8 bytes of every message body (what a byte-based token bound must cover). */
export function structuredContentBytes(messages: readonly StructuredChatMessage[]): number {
  return messages.reduce((sum, message) => sum + encoder.encode(message.content).length, 0);
}
