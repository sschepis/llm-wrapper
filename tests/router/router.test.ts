import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMRouter } from '../../src/router/router.js';
import { PriorityStrategy, CustomStrategy } from '../../src/router/strategies.js';
import { BaseProvider } from '../../src/core/base-provider.js';
import { LLMError, LLMErrorCode } from '../../src/core/errors.js';
import type { StandardChatParams, StandardChatResponse, StandardChatChunk, ProviderConfig } from '../../src/core/types.js';
import type { Endpoint, RouterConfig } from '../../src/router/types.js';

// --- Mock provider that doesn't require any SDK ---

class MockProvider extends BaseProvider {
  public readonly providerName: string = 'mock';
  public chatResponse: StandardChatResponse;
  public shouldFail = false;
  public failError?: LLMError;
  public callCount = 0;

  constructor(config: ProviderConfig, response?: Partial<StandardChatResponse>) {
    super(config);
    this.chatResponse = {
      id: 'mock-id',
      object: 'chat.completion',
      created: 123,
      model: 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'mock response' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      ...response,
    };
  }

  protected async doChat(params: StandardChatParams): Promise<StandardChatResponse> {
    this.callCount++;
    if (this.shouldFail) {
      throw this.failError ?? new LLMError('mock fail', LLMErrorCode.PROVIDER_UNAVAILABLE, 'mock', 500, true);
    }
    return { ...this.chatResponse, model: params.model };
  }

  protected async *doStream(params: StandardChatParams): AsyncIterable<StandardChatChunk> {
    if (this.shouldFail) {
      throw this.failError ?? new LLMError('mock fail', LLMErrorCode.PROVIDER_UNAVAILABLE, 'mock', 500, true);
    }
    yield {
      id: 'chunk-1',
      object: 'chat.completion.chunk',
      created: 123,
      model: params.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    };
  }

  protected mapError(error: unknown): LLMError {
    return error instanceof LLMError ? error : new LLMError(String(error), LLMErrorCode.UNKNOWN, 'mock');
  }
}

// Mock createProvider to return our MockProvider
vi.mock('../../src/core/factory.js', () => ({
  createProvider: vi.fn(async (_name: string, config: ProviderConfig) => {
    return new MockProvider(config);
  }),
}));

function makeEndpoint(name: string, overrides?: Partial<Endpoint>): Endpoint {
  return {
    name,
    provider: 'openai',
    model: `model-${name}`,
    config: { apiKey: 'test', maxRetries: 0 },
    priority: 0,
    ...overrides,
  };
}

describe('LLMRouter', () => {
  const params: StandardChatParams = {
    model: 'auto',
    messages: [{ role: 'user', content: 'Hello' }],
  };

  describe('basic routing', () => {
    it('should route to the highest priority endpoint', async () => {
      const router = await LLMRouter.create({
        endpoints: [
          makeEndpoint('secondary', { priority: 1 }),
          makeEndpoint('primary', { priority: 0 }),
        ],
      });

      const response = await router.chat(params);
      expect(response.model).toBe('model-primary');
    });

    it('should override params.model with endpoint model', async () => {
      const router = await LLMRouter.create({
        endpoints: [makeEndpoint('ep', { model: 'gpt-4o' })],
      });

      const response = await router.chat({ ...params, model: 'anything' });
      expect(response.model).toBe('gpt-4o');
    });
  });

  describe('fallback', () => {
    it('should fallback to next endpoint on failure', async () => {
      const { createProvider } = await import('../../src/core/factory.js');
      const mockCreate = createProvider as ReturnType<typeof vi.fn>;

      let callIndex = 0;
      mockCreate.mockImplementation(async (_name: string, config: ProviderConfig) => {
        const provider = new MockProvider(config);
        const idx = callIndex++;
        if (idx === 0) {
          provider.shouldFail = true; // First endpoint fails
        }
        return provider;
      });

      const router = await LLMRouter.create({
        endpoints: [
          makeEndpoint('primary', { priority: 0 }),
          makeEndpoint('fallback', { priority: 1 }),
        ],
        fallback: true,
      });

      const response = await router.chat(params);
      expect(response.model).toBe('model-fallback');
    });

    it('should throw when all endpoints fail', async () => {
      const { createProvider } = await import('../../src/core/factory.js');
      const mockCreate = createProvider as ReturnType<typeof vi.fn>;

      mockCreate.mockImplementation(async (_name: string, config: ProviderConfig) => {
        const provider = new MockProvider(config);
        provider.shouldFail = true;
        return provider;
      });

      const router = await LLMRouter.create({
        endpoints: [
          makeEndpoint('a', { priority: 0 }),
          makeEndpoint('b', { priority: 1 }),
        ],
        fallback: true,
        maxFallbackAttempts: 1,
      });

      await expect(router.chat(params)).rejects.toThrow(LLMError);
    });

    it('should not fallback when disabled', async () => {
      const { createProvider } = await import('../../src/core/factory.js');
      const mockCreate = createProvider as ReturnType<typeof vi.fn>;

      mockCreate.mockImplementation(async (_name: string, config: ProviderConfig) => {
        const provider = new MockProvider(config);
        provider.shouldFail = true;
        return provider;
      });

      const router = await LLMRouter.create({
        endpoints: [
          makeEndpoint('a'),
          makeEndpoint('b'),
        ],
        fallback: false,
      });

      await expect(router.chat(params)).rejects.toThrow(LLMError);
    });
  });

  describe('events', () => {
    it('should emit route event', async () => {
      const { createProvider } = await import('../../src/core/factory.js');
      (createProvider as ReturnType<typeof vi.fn>).mockImplementation(
        async (_n: string, c: ProviderConfig) => new MockProvider(c),
      );

      const router = await LLMRouter.create({
        endpoints: [makeEndpoint('ep')],
      });

      const handler = vi.fn();
      router.events.on('route', handler);

      await router.chat(params);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].decision.endpoint.name).toBe('ep');
    });

    it('should emit request:complete on success', async () => {
      const { createProvider } = await import('../../src/core/factory.js');
      (createProvider as ReturnType<typeof vi.fn>).mockImplementation(
        async (_n: string, c: ProviderConfig) => new MockProvider(c),
      );

      const router = await LLMRouter.create({
        endpoints: [makeEndpoint('ep')],
      });

      const handler = vi.fn();
      router.events.on('request:complete', handler);

      await router.chat(params);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('health state', () => {
    it('should return health state for all endpoints', async () => {
      const { createProvider } = await import('../../src/core/factory.js');
      (createProvider as ReturnType<typeof vi.fn>).mockImplementation(
        async (_n: string, c: ProviderConfig) => new MockProvider(c),
      );

      const router = await LLMRouter.create({
        endpoints: [makeEndpoint('a'), makeEndpoint('b')],
      });

      const health = router.getHealthState();
      expect(health.size).toBe(2);
      expect(health.get('a')?.status).toBe('closed');
      expect(health.get('b')?.status).toBe('closed');
    });

    it('should reset health', async () => {
      const { createProvider } = await import('../../src/core/factory.js');
      (createProvider as ReturnType<typeof vi.fn>).mockImplementation(
        async (_n: string, c: ProviderConfig) => new MockProvider(c),
      );

      const router = await LLMRouter.create({
        endpoints: [makeEndpoint('a')],
      });

      await router.chat(params);
      router.resetHealth();
      const health = router.getHealthState();
      expect(health.get('a')?.totalRequests).toBe(0);
    });
  });

  describe('streaming', () => {
    it('should stream from routed endpoint', async () => {
      const { createProvider } = await import('../../src/core/factory.js');
      (createProvider as ReturnType<typeof vi.fn>).mockImplementation(
        async (_n: string, c: ProviderConfig) => new MockProvider(c),
      );

      const router = await LLMRouter.create({
        endpoints: [makeEndpoint('ep')],
      });

      const chunks: StandardChatChunk[] = [];
      for await (const chunk of router.stream(params)) {
        chunks.push(chunk);
      }
      expect(chunks).toHaveLength(1);
      expect(chunks[0].choices[0].delta.content).toBe('hi');
    });
  });

  describe('dynamic endpoints', () => {
    it('should add and remove endpoints at runtime', async () => {
      const { createProvider } = await import('../../src/core/factory.js');
      (createProvider as ReturnType<typeof vi.fn>).mockImplementation(
        async (_n: string, c: ProviderConfig) => new MockProvider(c),
      );

      const router = await LLMRouter.create({
        endpoints: [makeEndpoint('a')],
      });

      await router.addEndpoint(makeEndpoint('b', { priority: -1 }));
      let health = router.getHealthState();
      expect(health.size).toBe(2);

      router.removeEndpoint('a');
      health = router.getHealthState();
      expect(health.size).toBe(1);
      expect(health.has('b')).toBe(true);
    });
  });
});
