import type { VertexAI, GenerativeModel } from '@google-cloud/vertexai';
import { BaseProvider } from '../core/base-provider.js';
import { LLMError, LLMErrorCode } from '../core/errors.js';
import { sanitizeGeminiSchema } from './gemini-schema.js';
import type {
  StandardChatParams,
  StandardChatResponse,
  StandardChatChunk,
  ProviderConfig,
  ToolCall,
} from '../core/types.js';

export interface VertexGeminiConfig extends ProviderConfig {
  projectId: string;
  location?: string;
}

export class VertexGeminiProvider extends BaseProvider {
  public readonly providerName = 'vertex-gemini';
  private vertexAI: VertexAI;

  constructor(config: VertexGeminiConfig) {
    super(config);
    const VertexModule = require('@google-cloud/vertexai') as typeof import('@google-cloud/vertexai');
    this.vertexAI = new VertexModule.VertexAI({
      project: config.projectId,
      location: config.location ?? 'us-central1',
    });
  }

  protected async doChat(params: StandardChatParams): Promise<StandardChatResponse> {
    const model = this.getModel(params);
    const { contents, systemInstruction } = this.transformRequest(params);

    const result = await model.generateContent({
      contents: contents as any,
      ...(systemInstruction ? { systemInstruction: { role: 'system' as any, parts: [{ text: systemInstruction }] } } : {}),
    });

    return this.transformResponse(result.response, params.model);
  }

  protected async *doStream(params: StandardChatParams): AsyncIterable<StandardChatChunk> {
    const model = this.getModel(params);
    const { contents, systemInstruction } = this.transformRequest(params);

    const result = await model.generateContentStream({
      contents: contents as any,
      ...(systemInstruction ? { systemInstruction: { role: 'system' as any, parts: [{ text: systemInstruction }] } } : {}),
    });

    const id = this.generateId();
    const created = Math.floor(Date.now() / 1000);
    let emittedRole = false;
    const emittedToolCallKeys = new Set<string>();
    let emittedToolCallIndex = 0;

    for await (const chunk of result.stream) {
      const candidate = chunk.candidates?.[0];
      if (!candidate) continue;

      const parts = candidate.content?.parts ?? [];
      const toolCalls: StandardChatChunk['choices'][0]['delta']['tool_calls'] = [];
      // Gemini streams text incrementally — each chunk's parts carry only
      // new text. Emit directly; do not slice against prior state.
      let textDelta = '';

      for (const part of parts) {
        if ((part as any).thought === true) continue;
        if ('text' in part && part.text) textDelta += part.text;
        if ('functionCall' in part && part.functionCall) {
          const argsJson = JSON.stringify(part.functionCall.args ?? {});
          const key = `${part.functionCall.name}|${argsJson}`;
          if (emittedToolCallKeys.has(key)) continue;
          emittedToolCallKeys.add(key);
          const sig = (part as any).thoughtSignature;
          toolCalls.push({
            index: emittedToolCallIndex++,
            id: this.generateId(),
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: argsJson,
            },
            ...(sig ? { thought_signature: sig } : {}),
          });
        }
      }

      const delta: StandardChatChunk['choices'][0]['delta'] = {};
      if (!emittedRole) { delta.role = 'assistant'; emittedRole = true; }
      if (textDelta) delta.content = textDelta;
      if (toolCalls.length > 0) delta.tool_calls = toolCalls;

      yield {
        id,
        object: 'chat.completion.chunk',
        created,
        model: params.model,
        choices: [{
          index: 0,
          delta,
          finish_reason: this.mapFinishReason(candidate.finishReason as string | undefined),
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
      if (message.includes('PERMISSION_DENIED') || message.includes('403')) {
        return new LLMError(message, LLMErrorCode.INVALID_API_KEY, this.providerName, 403, false, { cause: error });
      }
      if (message.includes('RESOURCE_EXHAUSTED') || message.includes('429')) {
        return new LLMError(message, LLMErrorCode.RATE_LIMIT, this.providerName, 429, true, { cause: error });
      }
      if (message.includes('NOT_FOUND') || message.includes('404')) {
        return new LLMError(message, LLMErrorCode.MODEL_NOT_FOUND, this.providerName, 404, false, { cause: error });
      }
      if (message.includes('UNAVAILABLE') || message.includes('503')) {
        return new LLMError(message, LLMErrorCode.PROVIDER_UNAVAILABLE, this.providerName, 503, true, { cause: error });
      }
      return new LLMError(message, LLMErrorCode.UNKNOWN, this.providerName, undefined, false, { cause: error });
    }
    return new LLMError(String(error), LLMErrorCode.UNKNOWN, this.providerName);
  }

  // --- Helpers (mirrors GeminiProvider logic but uses Vertex SDK types) ---

  private getModel(params: StandardChatParams): GenerativeModel {
    const generationConfig: Record<string, unknown> = {};
    if (params.temperature !== undefined) generationConfig.temperature = params.temperature;
    if (params.max_tokens !== undefined) generationConfig.maxOutputTokens = params.max_tokens;
    if (params.top_p !== undefined) generationConfig.topP = params.top_p;
    if (params.stop) generationConfig.stopSequences = Array.isArray(params.stop) ? params.stop : [params.stop];

    const modelConfig: Record<string, unknown> = {
      model: params.model,
    };
    if (Object.keys(generationConfig).length > 0) modelConfig.generationConfig = generationConfig;

    if (params.tools?.length) {
      modelConfig.tools = [{
        functionDeclarations: params.tools.map(t => ({
          name: t.function.name,
          description: t.function.description,
          parameters: sanitizeGeminiSchema(t.function.parameters),
        })),
      }];
      if (params.tool_choice) {
        const modeMap: Record<string, string> = { none: 'NONE', auto: 'AUTO', required: 'ANY' };
        const mode = typeof params.tool_choice === 'string' ? modeMap[params.tool_choice] ?? 'AUTO' : 'AUTO';
        modelConfig.toolConfig = { functionCallingConfig: { mode } };
      }
    }

    return this.vertexAI.getGenerativeModel(modelConfig as any);
  }

  private transformRequest(params: StandardChatParams): {
    contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    systemInstruction?: string;
  } {
    const systemParts: string[] = [];
    const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

    for (const msg of params.messages) {
      if (msg.role === 'system') {
        if (typeof msg.content === 'string') systemParts.push(msg.content);
        continue;
      }

      if (msg.role === 'tool') {
        const part = {
          functionResponse: {
            name: msg.name ?? 'unknown',
            response: { result: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) },
          },
        };
        const last = contents[contents.length - 1];
        if (last && last.role === 'function') {
          last.parts.push(part);
        } else {
          contents.push({ role: 'function', parts: [part] });
        }
        continue;
      }

      const geminiRole = msg.role === 'assistant' ? 'model' : 'user';
      const parts: Array<Record<string, unknown>> = [];

      if (typeof msg.content === 'string' && msg.content) {
        parts.push({ text: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (!tc.thought_signature) continue;
          parts.push({
            functionCall: { name: tc.function.name, args: JSON.parse(tc.function.arguments) },
            thoughtSignature: tc.thought_signature,
          });
        }
      }

      if (parts.length > 0) {
        const last = contents[contents.length - 1];
        if (last && last.role === geminiRole) {
          last.parts.push(...parts);
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

  private transformResponse(response: any, model: string): StandardChatResponse {
    const candidate = response.candidates?.[0];
    let textContent = '';
    const toolCalls: ToolCall[] = [];

    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.thought === true) continue;
        if (part.text) textContent += part.text;
        if (part.functionCall) {
          const sig = part.thoughtSignature;
          toolCalls.push({
            id: this.generateId(),
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args ?? {}),
            },
            ...(sig ? { thought_signature: sig } : {}),
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

  private mapFinishReason(reason: string | undefined): 'stop' | 'tool_calls' | 'length' | 'content_filter' | null {
    if (!reason) return null;
    const map: Record<string, 'stop' | 'tool_calls' | 'length' | 'content_filter'> = {
      STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter', RECITATION: 'content_filter',
    };
    return map[reason] ?? 'stop';
  }

  private generateId(): string {
    return `vtx-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}
