import { describe, it, expect } from 'vitest';
import { LLMError, LLMErrorCode } from '../../src/core/errors.js';

describe('LLMError', () => {
  it('should create an error with all properties', () => {
    const error = new LLMError('rate limited', LLMErrorCode.RATE_LIMIT, 'openai', 429, true);
    expect(error.message).toBe('rate limited');
    expect(error.code).toBe('LLM_RATE_LIMIT_REACHED');
    expect(error.provider).toBe('openai');
    expect(error.statusCode).toBe(429);
    expect(error.retryable).toBe(true);
    expect(error.name).toBe('LLMError');
    expect(error).toBeInstanceOf(Error);
  });

  it('should default retryable to false', () => {
    const error = new LLMError('bad key', LLMErrorCode.INVALID_API_KEY, 'anthropic', 401);
    expect(error.retryable).toBe(false);
  });

  it('should support error cause', () => {
    const cause = new Error('original');
    const error = new LLMError('wrapped', LLMErrorCode.UNKNOWN, 'gemini', undefined, false, { cause });
    expect(error.cause).toBe(cause);
  });
});
