import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseProvider } from '../../src/core/base-provider.js';
import { LLMError, LLMErrorCode } from '../../src/core/errors.js';
import type { StandardChatParams, StandardChatResponse, StandardChatChunk } from '../../src/core/types.js';

// Concrete test implementation
class MockProvider extends BaseProvider {
  public readonly providerName = 'mock';
  public doChatFn: (params: StandardChatParams) => Promise<StandardChatResponse>;
  public doStreamFn: (params: StandardChatParams) => AsyncIterable<StandardChatChunk>;

  constructor(config = { apiKey: 'test-key' }) {
    super(config);
    this.doChatFn = async () => mockResponse();
    this.doStreamFn = async function* () {};
  }

  protected async doChat(params: StandardChatParams): Promise<StandardChatResponse> {
    return this.doChatFn(params);
  }

  protected async *doStream(params: StandardChatParams): AsyncIterable<StandardChatChunk> {
    yield* this.doStreamFn(params);
  }

  protected mapError(error: unknown): LLMError {
    return new LLMError(
      error instanceof Error ? error.message : String(error),
      LLMErrorCode.UNKNOWN,
      'mock',
    );
  }
}

function mockResponse(content = 'Hello!'): StandardChatResponse {
  return {
    id: 'test-id',
    object: 'chat.completion',
    created: 1234567890,
    model: 'test-model',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

const validParams: StandardChatParams = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'Hello' }],
};

describe('BaseProvider', () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
  });

  describe('chat', () => {
    it('should return a response for valid params', async () => {
      const response = await provider.chat(validParams);
      expect(response.choices[0].message.content).toBe('Hello!');
    });

    it('should reject invalid params', async () => {
      await expect(provider.chat({ model: '', messages: [] } as any)).rejects.toThrow(LLMError);
    });

    it('should call onBeforeRequest hook', async () => {
      const hook = vi.fn((p: StandardChatParams) => ({ ...p, model: 'hooked' }));
      provider = new MockProvider({ apiKey: 'test', hooks: { onBeforeRequest: hook } });
      provider.doChatFn = async (params) => mockResponse(params.model);

      const response = await provider.chat(validParams);
      expect(hook).toHaveBeenCalled();
      expect(response.choices[0].message.content).toBe('hooked');
    });

    it('should call onAfterResponse hook', async () => {
      const hook = vi.fn();
      provider = new MockProvider({ apiKey: 'test', hooks: { onAfterResponse: hook } });

      await provider.chat(validParams);
      expect(hook).toHaveBeenCalledWith(expect.objectContaining({ id: 'test-id' }));
    });
  });

  describe('retry logic', () => {
    it('should retry on retryable errors', async () => {
      let attempts = 0;
      provider = new MockProvider({ apiKey: 'test', maxRetries: 2 });
      provider.doChatFn = async () => {
        attempts++;
        if (attempts < 3) {
          throw new LLMError('rate limited', LLMErrorCode.RATE_LIMIT, 'mock', 429, true);
        }
        return mockResponse();
      };

      // Mock sleep to avoid actual delays
      (provider as any).sleep = vi.fn().mockResolvedValue(undefined);

      const response = await provider.chat(validParams);
      expect(attempts).toBe(3);
      expect(response.choices[0].message.content).toBe('Hello!');
    });

    it('should not retry on non-retryable errors', async () => {
      let attempts = 0;
      provider.doChatFn = async () => {
        attempts++;
        throw new LLMError('bad key', LLMErrorCode.INVALID_API_KEY, 'mock', 401, false);
      };

      await expect(provider.chat(validParams)).rejects.toThrow('bad key');
      expect(attempts).toBe(1);
    });

    it('should call onError hook on failure', async () => {
      const hook = vi.fn();
      provider = new MockProvider({ apiKey: 'test', hooks: { onError: hook } });
      provider.doChatFn = async () => {
        throw new LLMError('fail', LLMErrorCode.UNKNOWN, 'mock');
      };

      await expect(provider.chat(validParams)).rejects.toThrow();
      expect(hook).toHaveBeenCalled();
    });
  });

  describe('stream', () => {
    it('should yield chunks', async () => {
      const chunk: StandardChatChunk = {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        created: 123,
        model: 'test',
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: 'Hi' },
          finish_reason: null,
        }],
      };

      provider.doStreamFn = async function* () { yield chunk; };

      const chunks: StandardChatChunk[] = [];
      for await (const c of provider.stream(validParams)) {
        chunks.push(c);
      }
      expect(chunks).toHaveLength(1);
      expect(chunks[0].choices[0].delta.content).toBe('Hi');
    });
  });
});
