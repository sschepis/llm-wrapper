import type {
  GoogleGenerativeAI,
  GenerativeModel,
  Content,
  Part,
  FunctionCallingMode,
  GenerateContentResult,
  EnhancedGenerateContentResponse,
} from '@google/generative-ai';
import { BaseProvider } from '../core/base-provider.js';
import { LLMError, LLMErrorCode } from '../core/errors.js';
import type {
  StandardChatParams,
  StandardChatResponse,
  StandardChatChunk,
  ProviderConfig,
  Message,
  ToolDefinition,
  ToolCall,
} from '../core/types.js';

export class GeminiProvider extends BaseProvider {
  public readonly providerName = 'gemini';
  protected genAI: GoogleGenerativeAI;

  constructor(config: ProviderConfig) {
    super(config);
    const GeminiModule = require('@google/generative-ai') as typeof import('@google/generative-ai');
    this.genAI = new GeminiModule.GoogleGenerativeAI(config.apiKey);
  }

  protected async doChat(params: StandardChatParams): Promise<StandardChatResponse> {
    const model = this.getModel(params);
    const { contents, systemInstruction } = this.transformRequest(params);

    const result = await model.generateContent({
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
    });

    return this.transformResponse(result, params.model);
  }

  protected async *doStream(params: StandardChatParams): AsyncIterable<StandardChatChunk> {
    const model = this.getModel(params);
    const { contents, systemInstruction } = this.transformRequest(params);

    const result = await model.generateContentStream({
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
    });

    const id = this.generateId();
    const created = Math.floor(Date.now() / 1000);
    let previousText = '';
    let emittedRole = false;

    for await (const chunk of result.stream) {
      const candidate = chunk.candidates?.[0];
      if (!candidate) continue;

      const parts = candidate.content?.parts ?? [];
      let textDelta = '';
      const toolCalls: StandardChatChunk['choices'][0]['delta']['tool_calls'] = [];

      // Compute text delta
      let fullText = '';
      for (const part of parts) {
        if ('text' in part && part.text) {
          fullText += part.text;
        }
        if ('functionCall' in part && part.functionCall) {
          toolCalls.push({
            index: toolCalls.length,
            id: this.generateId(),
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args ?? {}),
            },
          });
        }
      }

      textDelta = fullText.slice(previousText.length);
      previousText = fullText;

      const delta: StandardChatChunk['choices'][0]['delta'] = {};
      if (!emittedRole) {
        delta.role = 'assistant';
        emittedRole = true;
      }
      if (textDelta) delta.content = textDelta;
      if (toolCalls.length > 0) delta.tool_calls = toolCalls;

      const finishReason = this.mapFinishReason(candidate.finishReason);

      yield {
        id,
        object: 'chat.completion.chunk',
        created,
        model: params.model,
        choices: [{
          index: 0,
          delta,
          finish_reason: finishReason,
        }],
        usage: chunk.usageMetadata ? {
          prompt_tokens: chunk.usageMetadata.promptTokenCount ?? 0,
          completion_tokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
          total_tokens: chunk.usageMetadata.totalTokenCount ?? 0,
        } : undefined,
      };
    }
  }

  protected mapError(error: unknown): LLMError {
    if (error instanceof Error) {
      const message = error.message;

      if (message.includes('API key')) {
        return new LLMError(message, LLMErrorCode.INVALID_API_KEY, this.providerName, 401, false, { cause: error });
      }
      if (message.includes('quota') || message.includes('rate')) {
        return new LLMError(message, LLMErrorCode.RATE_LIMIT, this.providerName, 429, true, { cause: error });
      }
      if (message.includes('not found') || message.includes('not supported')) {
        return new LLMError(message, LLMErrorCode.MODEL_NOT_FOUND, this.providerName, 404, false, { cause: error });
      }
      if (message.includes('safety') || message.includes('blocked')) {
        return new LLMError(message, LLMErrorCode.CONTENT_FILTER, this.providerName, 400, false, { cause: error });
      }
      if (message.includes('context') || message.includes('token')) {
        return new LLMError(message, LLMErrorCode.CONTEXT_EXCEEDED, this.providerName, 400, false, { cause: error });
      }

      return new LLMError(message, LLMErrorCode.UNKNOWN, this.providerName, undefined, false, { cause: error });
    }

    return new LLMError(String(error), LLMErrorCode.UNKNOWN, this.providerName);
  }

  // --- Protected helpers (reusable by VertexGeminiProvider) ---

  protected getModel(params: StandardChatParams): GenerativeModel {
    const modelConfig: Record<string, unknown> = {
      model: params.model,
    };

    if (params.temperature !== undefined) {
      modelConfig.generationConfig = {
        ...(modelConfig.generationConfig as Record<string, unknown> ?? {}),
        temperature: params.temperature,
      };
    }
    if (params.max_tokens !== undefined) {
      modelConfig.generationConfig = {
        ...(modelConfig.generationConfig as Record<string, unknown> ?? {}),
        maxOutputTokens: params.max_tokens,
      };
    }
    if (params.top_p !== undefined) {
      modelConfig.generationConfig = {
        ...(modelConfig.generationConfig as Record<string, unknown> ?? {}),
        topP: params.top_p,
      };
    }
    if (params.stop) {
      modelConfig.generationConfig = {
        ...(modelConfig.generationConfig as Record<string, unknown> ?? {}),
        stopSequences: Array.isArray(params.stop) ? params.stop : [params.stop],
      };
    }

    if (params.tools?.length) {
      modelConfig.tools = [{
        functionDeclarations: params.tools.map(t => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      }];

      if (params.tool_choice) {
        modelConfig.toolConfig = {
          functionCallingConfig: {
            mode: this.mapToolChoice(params.tool_choice),
          },
        };
      }
    }

    return this.genAI.getGenerativeModel(modelConfig as any);
  }

  protected transformRequest(params: StandardChatParams): {
    contents: Content[];
    systemInstruction?: string;
  } {
    const systemParts: string[] = [];
    const contents: Content[] = [];

    for (const msg of params.messages) {
      if (msg.role === 'system') {
        if (typeof msg.content === 'string') {
          systemParts.push(msg.content);
        }
        continue;
      }

      if (msg.role === 'tool') {
        // Tool results become function response parts
        const functionResponse: Part = {
          functionResponse: {
            name: msg.name ?? 'unknown',
            response: { result: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) },
          },
        } as Part;

        // Group with previous function role or create new
        const lastContent = contents[contents.length - 1];
        if (lastContent && lastContent.role === 'function') {
          lastContent.parts.push(functionResponse);
        } else {
          contents.push({
            role: 'function' as any,
            parts: [functionResponse],
          });
        }
        continue;
      }

      const geminiRole = msg.role === 'assistant' ? 'model' : 'user';
      const parts: Part[] = [];

      // Handle content
      if (typeof msg.content === 'string' && msg.content) {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            parts.push({ text: part.text });
          }
          // Image parts could be mapped here in the future
        }
      }

      // Handle tool calls in assistant messages
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: JSON.parse(tc.function.arguments),
            },
          } as Part);
        }
      }

      if (parts.length > 0) {
        // Merge consecutive same-role messages
        const lastContent = contents[contents.length - 1];
        if (lastContent && lastContent.role === geminiRole) {
          lastContent.parts.push(...parts);
        } else {
          contents.push({ role: geminiRole, parts });
        }
      }
    }

    return {
      contents,
      systemInstruction: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    };
  }

  protected transformResponse(result: GenerateContentResult, model: string): StandardChatResponse {
    const response = result.response;
    const candidate = response.candidates?.[0];

    let textContent = '';
    const toolCalls: ToolCall[] = [];

    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if ('text' in part && part.text) {
          textContent += part.text;
        }
        if ('functionCall' in part && part.functionCall) {
          toolCalls.push({
            id: this.generateId(),
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args ?? {}),
            },
          });
        }
      }
    }

    return {
      id: this.generateId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: textContent || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: this.mapFinishReason(candidate?.finishReason),
      }],
      usage: {
        prompt_tokens: response.usageMetadata?.promptTokenCount ?? 0,
        completion_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        total_tokens: response.usageMetadata?.totalTokenCount ?? 0,
      },
    };
  }

  // --- Private helpers ---

  private mapToolChoice(choice: StandardChatParams['tool_choice']): string {
    if (choice === 'none') return 'NONE';
    if (choice === 'auto') return 'AUTO';
    if (choice === 'required') return 'ANY';
    return 'AUTO';
  }

  private mapFinishReason(reason: string | undefined): 'stop' | 'tool_calls' | 'length' | 'content_filter' | null {
    if (!reason) return null;
    const map: Record<string, 'stop' | 'tool_calls' | 'length' | 'content_filter'> = {
      STOP: 'stop',
      MAX_TOKENS: 'length',
      SAFETY: 'content_filter',
      RECITATION: 'content_filter',
    };
    return map[reason] ?? 'stop';
  }

  protected generateId(): string {
    return `gen-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}
