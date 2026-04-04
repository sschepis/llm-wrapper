import type {
  StandardChatChunk,
  StandardChatResponse,
  Message,
  ToolCall,
  Usage,
} from '../core/types.js';

/**
 * Collect an async stream of chunks into a final StandardChatResponse.
 */
export async function aggregateStream(
  stream: AsyncIterable<StandardChatChunk>,
): Promise<StandardChatResponse> {
  let id = '';
  let model = '';
  let created = 0;
  let role: Message['role'] = 'assistant';
  let content = '';
  let finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null = null;
  const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  for await (const chunk of stream) {
    if (!id) id = chunk.id;
    if (!model) model = chunk.model;
    if (!created) created = chunk.created;

    for (const choice of chunk.choices) {
      if (choice.delta.role) role = choice.delta.role;
      if (choice.delta.content) content += choice.delta.content;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      if (choice.delta.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const existing = toolCallsMap.get(tc.index);
          if (existing) {
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          } else {
            toolCallsMap.set(tc.index, {
              id: tc.id ?? '',
              name: tc.function?.name ?? '',
              arguments: tc.function?.arguments ?? '',
            });
          }
        }
      }
    }

    if (chunk.usage) {
      usage = chunk.usage;
    }
  }

  const toolCalls: ToolCall[] = [];
  for (const [, tc] of [...toolCallsMap.entries()].sort((a, b) => a[0] - b[0])) {
    toolCalls.push({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
    });
  }

  const message: Message = {
    role,
    content: content || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };

  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  };
}

/**
 * Tee a stream: yields chunks to the consumer AND collects them into a final response.
 */
export function teeStream(stream: AsyncIterable<StandardChatChunk>): {
  chunks: AsyncIterable<StandardChatChunk>;
  result: Promise<StandardChatResponse>;
} {
  const collected: StandardChatChunk[] = [];
  let resolveResult: (value: StandardChatResponse) => void;
  let rejectResult: (reason: unknown) => void;

  const result = new Promise<StandardChatResponse>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  async function* teedStream(): AsyncIterable<StandardChatChunk> {
    try {
      for await (const chunk of stream) {
        collected.push(chunk);
        yield chunk;
      }

      // After stream ends, aggregate
      async function* replay(): AsyncIterable<StandardChatChunk> {
        for (const c of collected) yield c;
      }
      const aggregated = await aggregateStream(replay());
      resolveResult!(aggregated);
    } catch (err) {
      rejectResult!(err);
      throw err;
    }
  }

  return { chunks: teedStream(), result };
}
