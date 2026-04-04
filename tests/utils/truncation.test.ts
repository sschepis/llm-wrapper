import { describe, it, expect } from 'vitest';
import { truncateMessages } from '../../src/utils/truncation.js';
import type { Message } from '../../src/core/types.js';

function msg(role: Message['role'], content: string): Message {
  return { role, content };
}

describe('truncateMessages', () => {
  it('should return messages unchanged if within budget', () => {
    const messages = [msg('user', 'Hi')];
    const result = truncateMessages(messages, 10000);
    expect(result).toEqual(messages);
  });

  it('should remove oldest non-system messages first', () => {
    const messages = [
      msg('system', 'You are helpful'),
      msg('user', 'First question ' + 'x'.repeat(200)),
      msg('assistant', 'First answer ' + 'x'.repeat(200)),
      msg('user', 'Second question'),
    ];

    const result = truncateMessages(messages, 100);
    // Should keep system and the last message at minimum
    expect(result[0].role).toBe('system');
    expect(result[result.length - 1].content).toBe('Second question');
    expect(result.length).toBeLessThan(messages.length);
  });

  it('should preserve system messages by default', () => {
    const messages = [
      msg('system', 'You are helpful'),
      msg('user', 'Q1 ' + 'x'.repeat(200)),
      msg('assistant', 'A1 ' + 'x'.repeat(200)),
      msg('user', 'Q2'),
    ];

    const result = truncateMessages(messages, 50);
    expect(result.some(m => m.role === 'system')).toBe(true);
  });

  it('should use middle strategy when specified', () => {
    const messages = [
      msg('user', 'First'),
      msg('assistant', 'A1 ' + 'x'.repeat(200)),
      msg('user', 'Middle ' + 'x'.repeat(200)),
      msg('assistant', 'A2 ' + 'x'.repeat(200)),
      msg('user', 'Last'),
    ];

    const result = truncateMessages(messages, 50, { strategy: 'middle' });
    expect(result[0].content).toBe('First');
    expect(result[result.length - 1].content).toBe('Last');
  });
});
