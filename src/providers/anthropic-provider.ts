import type Anthropic from '@anthropic-ai/sdk';
import { BaseProvider } from '../core/base-provider.js';
import { LLMError, LLMErrorCode } from '../core/errors.js';
import type {
  StandardChatParams,
  StandardChatResponse,
  StandardChatChunk,
  ProviderConfig,
  Message,
  ToolDefinition,
} from '../core/types.js';

const DEFAULT_MAX_TOKENS = 4096;

export class AnthropicProvider extends BaseProvider {
  public readonly providerName: string = 'anthropic';
  protected client: Anthropic;

  constructor(config: ProviderConfig) {
    super(config);
    const AnthropicModule = require('@anthropic-ai/sdk') as typeof import('@anthropic-ai/sdk');
    this.client = new AnthropicModule.default({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: this.config.timeout,
      defaultHeaders: config.headers,
    });
  }

  protected async doChat(params: StandardChatParams): Promise<StandardChatResponse> {
    const anthropicParams = this.transformRequest(params);
    try {
      const response = await this.client.messages.create(anthropicParams as any);
      return this.transformResponse(response);
    } catch (err: any) {
      if (this.isTemperatureDeprecatedError(err)) {
        delete (anthropicParams as any).temperature;
        delete (anthropicParams as any).top_p;
        const response = await this.client.messages.create(anthropicParams as any);
        return this.transformResponse(response);
      }
      throw err;
    }
  }

  protected async *doStream(params: StandardChatParams): AsyncIterable<StandardChatChunk> {
    const anthropicParams = this.transformRequest(params);
    const stream = this.client.messages.stream(anthropicParams as any);

    let messageId = '';
    let model = params.model;
    const created = Math.floor(Date.now() / 1000);
    let currentBlockIndex = 0;
    let toolCallIndex = -1;

    for await (const event of stream) {
      if (event.type === 'message_start') {
        messageId = event.message.id;
        model = event.message.model;
        continue;
      }

      if (event.type === 'content_block_start') {
        currentBlockIndex = event.index;
        const block = event.content_block;

        if (block.type === 'tool_use') {
          toolCallIndex++;
          yield {
            id: messageId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: toolCallIndex,
                  id: block.id,
                  type: 'function',
                  function: {
                    name: block.name,
                    arguments: '',
                  },
                }],
              },
              finish_reason: null,
            }],
          };
        } else if (block.type === 'text') {
          // Emit role on first text block
          if (currentBlockIndex === 0) {
            yield {
              id: messageId,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{
                index: 0,
                delta: { role: 'assistant' },
                finish_reason: null,
              }],
            };
          }
        }
        continue;
      }

      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield {
            id: messageId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
              index: 0,
              delta: { content: event.delta.text },
              finish_reason: null,
            }],
          };
        } else if (event.delta.type === 'input_json_delta') {
          yield {
            id: messageId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: toolCallIndex,
                  function: {
                    arguments: event.delta.partial_json,
                  },
                }],
              },
              finish_reason: null,
            }],
          };
        }
        continue;
      }

      if (event.type === 'message_delta') {
        const finishReason = this.mapStopReason(event.delta.stop_reason);
        yield {
          id: messageId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: finishReason,
          }],
          usage: event.usage ? {
            prompt_tokens: 0,
            completion_tokens: event.usage.output_tokens,
            total_tokens: event.usage.output_tokens,
          } : undefined,
        };
      }
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
      if (status >= 500) {
        return new LLMError(message, LLMErrorCode.PROVIDER_UNAVAILABLE, this.providerName, status, true, { cause: error });
      }
      if (status === 400) {
        const code = message.toLowerCase().includes('context') || message.toLowerCase().includes('token')
          ? LLMErrorCode.CONTEXT_EXCEEDED
          : LLMErrorCode.INVALID_REQUEST;
        return new LLMError(message, code, this.providerName, status, false, { cause: error });
      }

      return new LLMError(message, LLMErrorCode.INVALID_REQUEST, this.providerName, status, false, { cause: error });
    }

    const message = error instanceof Error ? error.message : String(error);
    return new LLMError(message, LLMErrorCode.UNKNOWN, this.providerName, undefined, false, {
      cause: error instanceof Error ? error : undefined,
    });
  }

  // --- Request transformation ---

  protected transformRequest(params: StandardChatParams): Record<string, unknown> {
    const { system, messages } = this.extractSystemMessages(params.messages);
    const convertedMessages = this.convertMessages(messages);

    const result: Record<string, unknown> = {
      model: params.model,
      messages: convertedMessages,
      max_tokens: params.max_tokens ?? DEFAULT_MAX_TOKENS,
    };

    if (system) result.system = system;
    const supportsTemp = this.supportsTemperature(params.model);
    if (supportsTemp && params.temperature !== undefined) result.temperature = params.temperature;
    if (supportsTemp && params.top_p !== undefined) result.top_p = params.top_p;
    if (params.stop) result.stop_sequences = Array.isArray(params.stop) ? params.stop : [params.stop];

    if (params.tools?.length) {
      result.tools = this.convertToolDefinitions(params.tools);
      if (params.tool_choice) {
        result.tool_choice = this.convertToolChoice(params.tool_choice);
      }
    }

    return result;
  }

  // --- Response transformation ---

  protected transformResponse(response: Anthropic.Message): StandardChatResponse {
    let textContent = '';
    const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    return {
      id: response.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: response.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: textContent || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: this.mapStopReason(response.stop_reason),
      }],
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      },
    };
  }

  // --- Private helpers ---

  private extractSystemMessages(messages: Message[]): { system: string | undefined; messages: Message[] } {
    const systemMessages: string[] = [];
    const nonSystemMessages: Message[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        if (typeof msg.content === 'string') {
          systemMessages.push(msg.content);
        }
      } else {
        nonSystemMessages.push(msg);
      }
    }

    return {
      system: systemMessages.length > 0 ? systemMessages.join('\n\n') : undefined,
      messages: nonSystemMessages,
    };
  }

  private convertMessages(messages: Message[]): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      if (msg.role === 'tool') {
        // Tool results become user messages with tool_result content blocks
        const lastMsg = result[result.length - 1];
        const toolResult = {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        };

        // Group consecutive tool results into a single user message
        if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
          (lastMsg.content as unknown[]).push(toolResult);
        } else {
          result.push({ role: 'user', content: [toolResult] });
        }
        continue;
      }

      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        // Assistant messages with tool calls become content blocks
        const content: unknown[] = [];
        if (msg.content && typeof msg.content === 'string') {
          content.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          });
        }
        result.push({ role: 'assistant', content });
        continue;
      }

      // Merge consecutive same-role messages
      const lastMsg = result[result.length - 1];
      if (lastMsg && lastMsg.role === msg.role && msg.role === 'user') {
        // Merge into previous
        const prevContent = typeof lastMsg.content === 'string' ? lastMsg.content : '';
        const curContent = typeof msg.content === 'string' ? msg.content : '';
        lastMsg.content = prevContent + '\n\n' + curContent;
        continue;
      }

      result.push({
        role: msg.role,
        content: msg.content,
      });
    }

    return result;
  }

  private convertToolDefinitions(tools: ToolDefinition[]): Array<Record<string, unknown>> {
    return tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
  }

  private convertToolChoice(choice: StandardChatParams['tool_choice']): Record<string, unknown> {
    if (choice === 'none') return { type: 'none' };
    if (choice === 'auto') return { type: 'auto' };
    if (choice === 'required') return { type: 'any' };
    if (typeof choice === 'object' && choice.function) {
      return { type: 'tool', name: choice.function.name };
    }
    return { type: 'auto' };
  }

  private mapStopReason(reason: string | null | undefined): 'stop' | 'tool_calls' | 'length' | 'content_filter' | null {
    if (!reason) return null;
    const map: Record<string, 'stop' | 'tool_calls' | 'length' | 'content_filter'> = {
      end_turn: 'stop',
      tool_use: 'tool_calls',
      max_tokens: 'length',
      stop_sequence: 'stop',
    };
    return map[reason] ?? 'stop';
  }

  private supportsTemperature(model: string): boolean {
    const m = model.toLowerCase();
    return !/claude-(4|opus-4|sonnet-4)/.test(m);
  }

  protected isTemperatureDeprecatedError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes('temperature') && msg.includes('deprecated');
  }
}
