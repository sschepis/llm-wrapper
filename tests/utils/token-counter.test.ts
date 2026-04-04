import { describe, it, expect } from 'vitest';
import { estimateTokens, validateContextWindow } from '../../src/utils/token-counter.js';
import type { Message } from '../../src/core/types.js';

describe('estimateTokens', () => {
  it('should estimate tokens for simple text messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello, how are you?' },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
    // "Hello, how are you?" = 19 chars + 16 overhead = 35 / 4 ≈ 9
    expect(tokens).toBeLessThan(20);
  });

  it('should handle null content', () => {
    const messages: Message[] = [
      { role: 'assistant', content: null },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBe(4); // just the role overhead
  });

  it('should count tool calls', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'tc-1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
        }],
      },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(4);
  });
});

describe('validateContextWindow', () => {
  it('should validate against known models', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hi' },
    ];
    const result = validateContextWindow(messages, 'gpt-4o');
    expect(result.ok).toBe(true);
    expect(result.contextWindow).toBe(128_000);
    expect(result.remainingTokens).toBeGreaterThan(0);
  });

  it('should return ok=true for unknown models', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hi' },
    ];
    const result = validateContextWindow(messages, 'unknown-model');
    expect(result.ok).toBe(true);
    expect(result.contextWindow).toBe(Infinity);
  });
});
