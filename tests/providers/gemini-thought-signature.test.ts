import { describe, it, expect } from 'vitest';
import { GeminiProvider } from '../../src/providers/gemini-provider.js';
import { aggregateStream } from '../../src/utils/stream-aggregator.js';
import type { StandardChatParams, StandardChatChunk, ToolCall } from '../../src/core/types.js';
import type { GenerateContentResult } from '@google/generative-ai';

// Expose protected transform methods for testing.
class TestableGeminiProvider extends GeminiProvider {
  public testTransformRequest(params: StandardChatParams) {
    return (this as any).transformRequest(params);
  }
  public testTransformResponse(result: GenerateContentResult, model: string) {
    return (this as any).transformResponse(result, model);
  }
}

function mkProvider() {
  return new TestableGeminiProvider({ apiKey: 'test-key' });
}

describe('GeminiProvider thought_signature round-trip', () => {
  it('captures thoughtSignature from non-streaming response', () => {
    const provider = mkProvider();
    const result = {
      response: {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: { name: 'terminal', args: { cmd: 'ls' } },
                  thoughtSignature: 'SIG-ABC-123',
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      },
    } as unknown as GenerateContentResult;

    const std = provider.testTransformResponse(result, 'gemini-3.1-pro-preview');
    const tc = std.choices[0].message.tool_calls?.[0];
    expect(tc).toBeDefined();
    expect(tc!.function.name).toBe('terminal');
    expect(tc!.thought_signature).toBe('SIG-ABC-123');
  });

  it('re-attaches thoughtSignature as sibling of functionCall on echo', () => {
    const provider = mkProvider();
    const params: StandardChatParams = {
      model: 'gemini-3.1-pro-preview',
      messages: [
        { role: 'user', content: 'run ls' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'terminal', arguments: '{"cmd":"ls"}' },
              thought_signature: 'SIG-ABC-123',
            },
          ],
        },
        { role: 'tool', name: 'terminal', tool_call_id: 'call_1', content: 'file.txt' },
      ],
    };

    const { contents } = provider.testTransformRequest(params);

    const modelContent = contents.find((c: any) => c.role === 'model');
    expect(modelContent).toBeDefined();
    const fcPart = modelContent!.parts.find((p: any) => p.functionCall) as any;
    expect(fcPart).toBeDefined();
    expect(fcPart.functionCall.name).toBe('terminal');
    // CRITICAL: signature is a sibling of functionCall, NOT nested inside it.
    expect(fcPart.thoughtSignature).toBe('SIG-ABC-123');
    expect(fcPart.functionCall.thoughtSignature).toBeUndefined();
    expect(fcPart.functionCall.thought_signature).toBeUndefined();
  });

  it('SKIPS thought-parts when concatenating response text (non-streaming)', () => {
    const provider = mkProvider();
    const result = {
      response: {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { thought: true, text: 'Let me plan this: user wants X, I should ' },
                { text: 'The answer is 42.' },
                { thought: true, text: ' then finalize with the key number.' },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
    } as unknown as GenerateContentResult;

    const std = provider.testTransformResponse(result, 'gemini-3.1-pro-preview');
    const content = std.choices[0].message.content;
    expect(content).toBe('The answer is 42.');
    expect(content).not.toContain('plan');
    expect(content).not.toContain('finalize');
  });

  it('omits thoughtSignature when none was captured', () => {
    const provider = mkProvider();
    const params: StandardChatParams = {
      model: 'gemini-3.1-pro-preview',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'terminal', arguments: '{}' },
            },
          ],
        },
      ],
    };

    const { contents } = provider.testTransformRequest(params);
    const fcPart = contents[0].parts.find((p: any) => p.functionCall) as any;
    expect(fcPart.thoughtSignature).toBeUndefined();
  });

  it('STREAMING: mock Gemini SDK stream skips thought parts', async () => {
    // Build a fake Gemini stream that interleaves thought and answer parts,
    // then exercise the real doStream logic. We stub the SDK by replacing
    // the provider's getModel method.
    const provider = mkProvider();

    async function* fakeStream() {
      yield {
        candidates: [{
          content: { role: 'model', parts: [
            { thought: true, text: 'Planning: ' },
            { text: 'Hello ' },
          ]},
        }],
      };
      yield {
        candidates: [{
          content: { role: 'model', parts: [
            { thought: true, text: 'still planning.' },
            { text: 'world.' },
          ]},
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
      };
    }

    (provider as any).getModel = () => ({
      generateContentStream: async () => ({ stream: fakeStream() }),
    });

    const params: StandardChatParams = {
      model: 'gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'hi' }],
    };

    let accumulated = '';
    for await (const chunk of (provider as any).doStream(params)) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) accumulated += delta.content;
    }
    expect(accumulated).toBe('Hello world.');
    expect(accumulated).not.toContain('planning');
    expect(accumulated).not.toContain('Planning');
  });

  it('STREAMING: aggregateStream preserves thought_signature through chunks', async () => {
    // Emulate what the Gemini provider's streaming code emits.
    const chunks: StandardChatChunk[] = [
      {
        id: 'chunk1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gemini-3.1-pro-preview',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"/tmp"}' },
              thought_signature: 'STREAM-SIG-XYZ',
            } as any],
          },
          finish_reason: null,
        }],
      },
      {
        id: 'chunk2',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gemini-3.1-pro-preview',
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'tool_calls',
        }],
      },
    ];

    async function* stream() { for (const c of chunks) yield c; }
    const aggregated = await aggregateStream(stream());
    const tc = aggregated.choices[0].message.tool_calls?.[0];
    expect(tc).toBeDefined();
    expect(tc!.function.name).toBe('read_file');
    expect(tc!.thought_signature).toBe('STREAM-SIG-XYZ');
  });

  it('STREAMING: emits each chunk\'s text delta correctly (incremental streams, not cumulative)', async () => {
    const provider = mkProvider();

    // Gemini streams are incremental: each chunk's parts contain NEW text
    // only, not the cumulative text so far.
    async function* fakeStream() {
      yield { candidates: [{ content: { role: 'model', parts: [{ text: 'Here is ' }] } }] };
      yield { candidates: [{ content: { role: 'model', parts: [{ text: 'a comprehensive ' }] } }] };
      yield { candidates: [{ content: { role: 'model', parts: [{ text: 'analysis.' }] }, finishReason: 'STOP' }] };
    }

    (provider as any).getModel = () => ({
      generateContentStream: async () => ({ stream: fakeStream() }),
    });

    const params: StandardChatParams = {
      model: 'gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'analyze' }],
    };

    let accumulated = '';
    for await (const chunk of (provider as any).doStream(params)) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) accumulated += delta.content;
    }
    expect(accumulated).toBe('Here is a comprehensive analysis.');
  });

  it('STREAMING: text delta is correct even when thought parts interleave across chunks', async () => {
    const provider = mkProvider();

    async function* fakeStream() {
      yield { candidates: [{ content: { role: 'model', parts: [
        { thought: true, text: 'Let me think...' },
        { text: 'Answer: ' },
      ]}}]};
      yield { candidates: [{ content: { role: 'model', parts: [
        { thought: true, text: 'still thinking...' },
        { text: '42.' },
      ]}, finishReason: 'STOP' }]};
    }

    (provider as any).getModel = () => ({
      generateContentStream: async () => ({ stream: fakeStream() }),
    });

    let accumulated = '';
    for await (const chunk of (provider as any).doStream({
      model: 'gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'q' }],
    })) {
      if (chunk.choices?.[0]?.delta?.content) accumulated += chunk.choices[0].delta.content;
    }
    expect(accumulated).toBe('Answer: 42.');
  });

  it('STREAMING: does not duplicate tool-call arguments when Gemini emits functionCall in multiple cumulative chunks', async () => {
    const provider = mkProvider();

    // Gemini streaming often re-emits the same functionCall part in
    // successive chunks (cumulative stream). The provider must emit the
    // tool call only once so the aggregator does not concatenate
    // identical JSON into invalid "{...}{...}".
    async function* fakeStream() {
      const fcPart = {
        functionCall: { name: 'read_file', args: { path: '/tmp/a', lines: 10 } },
      };
      yield {
        candidates: [{
          content: { role: 'model', parts: [fcPart] },
        }],
      };
      yield {
        candidates: [{
          content: { role: 'model', parts: [fcPart] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
      };
    }

    (provider as any).getModel = () => ({
      generateContentStream: async () => ({ stream: fakeStream() }),
    });

    const params: StandardChatParams = {
      model: 'gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'read it' }],
    };

    const chunks: StandardChatChunk[] = [];
    for await (const chunk of (provider as any).doStream(params)) {
      chunks.push(chunk);
    }
    async function* replay() { for (const c of chunks) yield c; }
    const aggregated = await aggregateStream(replay());

    const tc = aggregated.choices[0].message.tool_calls?.[0];
    expect(tc).toBeDefined();
    // The args JSON must parse cleanly — no duplication.
    const parsed = JSON.parse(tc!.function.arguments);
    expect(parsed).toEqual({ path: '/tmp/a', lines: 10 });
  });

  it('full round-trip: response → next request preserves signature byte-for-byte', () => {
    const provider = mkProvider();

    // 1. Gemini returns a functionCall with a signature
    const result = {
      response: {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: { name: 'read_file', args: { path: '/etc/hosts' } },
                  thoughtSignature: 'opaque-base64-blob==',
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
    } as unknown as GenerateContentResult;

    const std = provider.testTransformResponse(result, 'gemini-3.1-pro-preview');
    const capturedToolCall = std.choices[0].message.tool_calls![0] as ToolCall;
    expect(capturedToolCall.thought_signature).toBe('opaque-base64-blob==');

    // 2. Client echoes it back in the next turn
    const nextParams: StandardChatParams = {
      model: 'gemini-3.1-pro-preview',
      messages: [
        { role: 'user', content: 'read /etc/hosts' },
        { role: 'assistant', content: null, tool_calls: [capturedToolCall] },
        {
          role: 'tool',
          name: 'read_file',
          tool_call_id: capturedToolCall.id,
          content: '127.0.0.1 localhost',
        },
      ],
    };

    const { contents } = provider.testTransformRequest(nextParams);
    const modelContent = contents.find((c: any) => c.role === 'model')!;
    const fcPart = modelContent.parts.find((p: any) => p.functionCall) as any;

    expect(fcPart.thoughtSignature).toBe('opaque-base64-blob==');
    // Make absolutely sure the signature is NOT inside functionCall
    expect(fcPart.functionCall.thoughtSignature).toBeUndefined();
  });
});
