import type { Message } from '../core/types.js';
import { estimateTokens } from './token-counter.js';

export interface TruncationOptions {
  /** Strategy for removing messages. Default: 'oldest' */
  strategy?: 'oldest' | 'middle';
  /** Always preserve system messages. Default: true */
  preserveSystem?: boolean;
}

/**
 * Truncate messages to fit within a token budget.
 * Removes messages according to the chosen strategy while always preserving
 * the most recent user message and optionally system messages.
 */
export function truncateMessages(
  messages: Message[],
  maxTokens: number,
  options: TruncationOptions = {},
): Message[] {
  const { strategy = 'oldest', preserveSystem = true } = options;

  if (estimateTokens(messages) <= maxTokens) {
    return messages;
  }

  const result = [...messages];

  if (strategy === 'oldest') {
    // Remove from the start (after system messages), keeping the last message
    while (result.length > 1 && estimateTokens(result) > maxTokens) {
      const removeIndex = findOldestRemovable(result, preserveSystem);
      if (removeIndex === -1) break;
      result.splice(removeIndex, 1);
    }
  } else {
    // Remove from the middle, keeping first and last messages
    while (result.length > 2 && estimateTokens(result) > maxTokens) {
      const mid = Math.floor(result.length / 2);
      const removeIndex = findRemovableNear(result, mid, preserveSystem);
      if (removeIndex === -1) break;
      result.splice(removeIndex, 1);
    }
  }

  return result;
}

function findOldestRemovable(messages: Message[], preserveSystem: boolean): number {
  // Start from index 0, skip system messages if preserving, never remove last message
  for (let i = 0; i < messages.length - 1; i++) {
    if (preserveSystem && messages[i].role === 'system') continue;
    return i;
  }
  return -1;
}

function findRemovableNear(messages: Message[], target: number, preserveSystem: boolean): number {
  // Search outward from target, never remove first or last
  for (let offset = 0; offset < messages.length; offset++) {
    for (const idx of [target + offset, target - offset]) {
      if (idx > 0 && idx < messages.length - 1) {
        if (preserveSystem && messages[idx].role === 'system') continue;
        return idx;
      }
    }
  }
  return -1;
}
