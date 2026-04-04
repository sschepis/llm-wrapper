import type OpenAI from 'openai';
import { BaseProvider } from '../core/base-provider.js';
import { LLMError, LLMErrorCode } from '../core/errors.js';
import type {
  StandardChatParams,
  StandardChatResponse,
  StandardChatChunk,
  ProviderConfig,
  Message,
  ToolCall,
} from '../core/types.js';

export class OpenAIProvider extends BaseProvider {
  public readonly providerName: string = 'openai';
  protected client: OpenAI;

  constructor(config: ProviderConfig) {
    super(config);
    // Dynamic require to support optional peer dep
    const OpenAIModule = require('openai') as typeof import('openai');
    this.client = new OpenAIModule.default({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: this.config.timeout,
      defaultHeaders: config.headers,
    });
  }

  protected async doChat(params: StandardChatParams): Promise<StandardChatResponse> {
    const response = await this.client.chat.completions.create(
      this.mapParams(params) as any,
    );
    return this.mapResponse(response as OpenAI.Chat.Completions.ChatCompletion);
  }

  protected async *doStream(params: StandardChatParams): AsyncIterable<StandardChatChunk> {
    const stream = await this.client.chat.completions.create({
      ...this.mapParams(params),
      stream: true,
    } as any);

    for await (const chunk of stream as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
      yield this.mapChunk(chunk);
    }
  }

  protected mapError(error: unknown): LLMError {
    if (error instanceof Error && 'status' in error) {
      const status = (error as any).status as number;
      const message = error.message;

      if (status === 429) {
        return new LLMError(message, LLMErrorCode.RATE_LIMIT, this.providerName, status, true, { cause: error });
      }
      if (status === 401) {
        return new LLMError(message, LLMErrorCode.INVALID_API_KEY, this.providerName, status, false, { cause: error });
      }
      if (status === 404) {
        return new LLMError(message, LLMErrorCode.MODEL_NOT_FOUND, this.providerName, status, false, { cause: error });
      }
      if (status === 400 && message.toLowerCase().includes('context')) {
        return new LLMError(message, LLMErrorCode.CONTEXT_EXCEEDED, this.providerName, status, false, { cause: error });
      }
      if (status >= 500) {
        return new LLMError(message, LLMErrorCode.PROVIDER_UNAVAILABLE, this.providerName, status, true, { cause: error });
      }

      return new LLMError(message, LLMErrorCode.INVALID_REQUEST, this.providerName, status, false, { cause: error });
    }

    const message = error instanceof Error ? error.message : String(error);
    return new LLMError(message, LLMErrorCode.UNKNOWN, this.providerName, undefined, false, {
      cause: error instanceof Error ? error : undefined,
    });
  }

  // --- Mapping helpers ---

  private mapParams(params: StandardChatParams): Record<string, unknown> {
    const { stream, ...rest } = params;
    return {
      ...rest,
      messages: params.messages.map(m => this.mapMessageToOpenAI(m)),
    };
  }

  private mapMessageToOpenAI(msg: Message): Record<string, unknown> {
    const result: Record<string, unknown> = {
      role: msg.role,
      content: msg.content,
    };
    if (msg.name) result.name = msg.name;
    if (msg.tool_calls) result.tool_calls = msg.tool_calls;
    if (msg.tool_call_id) result.tool_call_id = msg.tool_call_id;
    return result;
  }

  private mapResponse(response: OpenAI.Chat.Completions.ChatCompletion): StandardChatResponse {
    return {
      id: response.id,
      object: 'chat.completion',
      created: response.created,
      model: response.model,
      choices: response.choices.map((c, i) => ({
        index: c.index ?? i,
        message: {
          role: c.message.role as Message['role'],
          content: c.message.content,
          tool_calls: c.message.tool_calls?.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        },
        finish_reason: this.mapFinishReason(c.finish_reason),
      })),
      usage: {
        prompt_tokens: response.usage?.prompt_tokens ?? 0,
        completion_tokens: response.usage?.completion_tokens ?? 0,
        total_tokens: response.usage?.total_tokens ?? 0,
      },
    };
  }

  private mapChunk(chunk: OpenAI.Chat.Completions.ChatCompletionChunk): StandardChatChunk {
    return {
      id: chunk.id,
      object: 'chat.completion.chunk',
      created: chunk.created,
      model: chunk.model,
      choices: chunk.choices.map((c, i) => ({
        index: c.index ?? i,
        delta: {
          role: c.delta.role as Message['role'] | undefined,
          content: c.delta.content ?? undefined,
          tool_calls: c.delta.tool_calls?.map(tc => ({
            index: tc.index,
            id: tc.id,
            type: tc.type as 'function' | undefined,
            function: tc.function ? {
              name: tc.function.name,
              arguments: tc.function.arguments,
            } : undefined,
          })),
        },
        finish_reason: this.mapFinishReason(c.finish_reason),
      })),
      usage: chunk.usage ? {
        prompt_tokens: chunk.usage.prompt_tokens,
        completion_tokens: chunk.usage.completion_tokens,
        total_tokens: chunk.usage.total_tokens,
      } : undefined,
    };
  }

  private mapFinishReason(reason: string | null | undefined): 'stop' | 'tool_calls' | 'length' | 'content_filter' | null {
    if (!reason) return null;
    const map: Record<string, 'stop' | 'tool_calls' | 'length' | 'content_filter'> = {
      stop: 'stop',
      tool_calls: 'tool_calls',
      length: 'length',
      content_filter: 'content_filter',
    };
    return map[reason] ?? 'stop';
  }
}
