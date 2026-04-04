import type { Message, ModelInfo } from '../core/types.js';
import { getModelInfo } from './model-registry.js';

/**
 * Estimate token count for an array of messages.
 * Uses a chars/4 heuristic — surprisingly accurate for English text.
 */
export function estimateTokens(messages: Message[], _model?: string): number {
  let totalChars = 0;

  for (const msg of messages) {
    // Role overhead (~4 tokens per message)
    totalChars += 16;

    if (typeof msg.content === 'string') {
      totalChars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text') {
          totalChars += part.text.length;
        } else if (part.type === 'image_url') {
          // Images are typically 85-1105 tokens depending on detail
          totalChars += 1000;
        }
      }
    }

    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        totalChars += tc.function.name.length;
        totalChars += tc.function.arguments.length;
        totalChars += 20; // overhead for tool call structure
      }
    }

    if (msg.name) totalChars += msg.name.length;
    if (msg.tool_call_id) totalChars += msg.tool_call_id.length;
  }

  return Math.ceil(totalChars / 4);
}

export interface ContextValidation {
  ok: boolean;
  estimatedTokens: number;
  contextWindow: number;
  remainingTokens: number;
}

/**
 * Validate that messages fit within a model's context window.
 */
export function validateContextWindow(messages: Message[], model: string): ContextValidation {
  const info = getModelInfo(model);
  if (!info) {
    // Unknown model — can't validate, assume ok
    return {
      ok: true,
      estimatedTokens: estimateTokens(messages, model),
      contextWindow: Infinity,
      remainingTokens: Infinity,
    };
  }

  const estimated = estimateTokens(messages, model);
  const remaining = info.contextWindow - estimated;

  return {
    ok: remaining > 0,
    estimatedTokens: estimated,
    contextWindow: info.contextWindow,
    remainingTokens: Math.max(0, remaining),
  };
}
