import { StandardChatParamsSchema } from './types.js';
import { LLMError, LLMErrorCode } from './errors.js';
import type { StandardChatParams, StandardChatResponse, StandardChatChunk, ProviderConfig } from './types.js';

export interface ResolvedConfig extends ProviderConfig {
  maxRetries: number;
  timeout: number;
}

export abstract class BaseProvider {
  protected config: ResolvedConfig;
  public abstract readonly providerName: string;

  constructor(config: ProviderConfig) {
    this.config = {
      maxRetries: 3,
      timeout: 60_000,
      ...config,
    };
  }

  /**
   * Send a chat completion request. Handles validation, hooks, and retries.
   * Providers implement doChat() instead.
   */
  async chat(params: StandardChatParams): Promise<StandardChatResponse> {
    const validated = this.validateParams(params);
    const hooked = await this.applyBeforeHook(validated);
    const response = await this.executeWithRetry(() => this.doChat(hooked));
    await this.config.hooks?.onAfterResponse?.(response);
    return response;
  }

  /**
   * Stream a chat completion. Handles validation and hooks.
   * Streams are NOT retried — partial consumption can't be replayed.
   */
  async *stream(params: StandardChatParams): AsyncIterable<StandardChatChunk> {
    const validated = this.validateParams(params);
    const hooked = await this.applyBeforeHook(validated);
    yield* this.doStream(hooked);
  }

  // --- Abstract methods providers MUST implement ---

  protected abstract doChat(params: StandardChatParams): Promise<StandardChatResponse>;
  protected abstract doStream(params: StandardChatParams): AsyncIterable<StandardChatChunk>;
  protected abstract mapError(error: unknown): LLMError;

  // --- Private helpers ---

  private validateParams(params: StandardChatParams): StandardChatParams {
    try {
      return StandardChatParamsSchema.parse(params);
    } catch (err) {
      throw new LLMError(
        `Invalid request parameters: ${err instanceof Error ? err.message : String(err)}`,
        LLMErrorCode.INVALID_REQUEST,
        this.providerName,
        undefined,
        false,
        { cause: err instanceof Error ? err : undefined },
      );
    }
  }

  private async applyBeforeHook(params: StandardChatParams): Promise<StandardChatParams> {
    if (this.config.hooks?.onBeforeRequest) {
      return await this.config.hooks.onBeforeRequest(params);
    }
    return params;
  }

  private async executeWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: LLMError | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (raw) {
        lastError = raw instanceof LLMError ? raw : this.mapError(raw);
        this.config.hooks?.onError?.(lastError);

        if (!lastError.retryable || attempt === this.config.maxRetries) {
          throw lastError;
        }

        // Exponential backoff with jitter, capped at 30s
        const baseDelay = Math.min(1000 * 2 ** attempt, 30_000);
        const jitter = baseDelay * (0.5 + Math.random() * 0.5);
        await this.sleep(jitter);
      }
    }

    throw lastError!;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
