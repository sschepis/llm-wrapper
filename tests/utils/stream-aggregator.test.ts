import { describe, it, expect } from 'vitest';
import { aggregateStream, teeStream } from '../../src/utils/stream-aggregator.js';
import type { StandardChatChunk } from '../../src/core/types.js';

function makeChunks(): StandardChatChunk[] {
  return [
    {
      id: 'ch-1',
      object: 'chat.completion.chunk',
      created: 100,
      model: 'test',
      choices: [{
        index: 0,
        delta: { role: 'assistant' },
        finish_reason: null,
      }],
    },
    {
      id: 'ch-1',
      object: 'chat.completion.chunk',
      created: 100,
      model: 'test',
      choices: [{
        index: 0,
        delta: { content: 'Hello' },
        finish_reason: null,
      }],
    },
    {
      id: 'ch-1',
      object: 'chat.completion.chunk',
      created: 100,
      model: 'test',
      choices: [{
        index: 0,
        delta: { content: ' world' },
        finish_reason: null,
      }],
    },
    {
      id: 'ch-1',
      object: 'chat.completion.chunk',
      created: 100,
      model: 'test',
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop',
      }],
    },
  ];
}

function makeToolCallChunks(): StandardChatChunk[] {
  return [
    {
      id: 'ch-1',
      object: 'chat.completion.chunk',
      created: 100,
      model: 'test',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'tc-1',
            type: 'function',
            function: { name: 'get_weather', arguments: '' },
          }],
        },
        finish_reason: null,
      }],
    },
    {
      id: 'ch-1',
      object: 'chat.completion.chunk',
      created: 100,
      model: 'test',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: '{"city"' },
          }],
        },
        finish_reason: null,
      }],
    },
    {
      id: 'ch-1',
      object: 'chat.completion.chunk',
      created: 100,
      model: 'test',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: ':"NYC"}' },
          }],
        },
        finish_reason: null,
      }],
    },
    {
      id: 'ch-1',
      object: 'chat.completion.chunk',
      created: 100,
      model: 'test',
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'tool_calls',
      }],
    },
  ];
}

async function* toAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

describe('aggregateStream', () => {
  it('should aggregate text chunks into a response', async () => {
    const response = await aggregateStream(toAsyncIterable(makeChunks()));
    expect(response.id).toBe('ch-1');
    expect(response.object).toBe('chat.completion');
    expect(response.choices[0].message.role).toBe('assistant');
    expect(response.choices[0].message.content).toBe('Hello world');
    expect(response.choices[0].finish_reason).toBe('stop');
  });

  it('should aggregate tool call chunks', async () => {
    const response = await aggregateStream(toAsyncIterable(makeToolCallChunks()));
    expect(response.choices[0].message.tool_calls).toHaveLength(1);
    const tc = response.choices[0].message.tool_calls![0];
    expect(tc.id).toBe('tc-1');
    expect(tc.function.name).toBe('get_weather');
    expect(tc.function.arguments).toBe('{"city":"NYC"}');
    expect(response.choices[0].finish_reason).toBe('tool_calls');
  });
});

describe('teeStream', () => {
  it('should yield chunks and provide aggregated result', async () => {
    const { chunks, result } = teeStream(toAsyncIterable(makeChunks()));

    const collected: StandardChatChunk[] = [];
    for await (const chunk of chunks) {
      collected.push(chunk);
    }

    expect(collected).toHaveLength(4);

    const response = await result;
    expect(response.choices[0].message.content).toBe('Hello world');
  });
});
