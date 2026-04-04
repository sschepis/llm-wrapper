# Utilities Guide

## Stream Aggregation

### `aggregateStream()`

Collects an async stream of chunks into a final `StandardChatResponse`. Handles text concatenation and tool call assembly across indexed deltas.

```typescript
import { aggregateStream } from '@sschepis/llm-wrapper';

const stream = client.stream({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
});

const response = await aggregateStream(stream);
console.log(response.choices[0].message.content); // Full text
```

### `teeStream()`

Yields chunks to the consumer AND collects them into a final response. Useful when you want to display streaming output and also get the final aggregated result.

```typescript
import { teeStream } from '@sschepis/llm-wrapper';

const { chunks, result } = teeStream(client.stream({ ... }));

// Display streaming output
for await (const chunk of chunks) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}

// Get final aggregated response (resolves after stream ends)
const response = await result;
console.log(response.usage.total_tokens);
```

## Token Counting

### `estimateTokens()`

Estimates token count for an array of messages using a chars/4 heuristic. Includes overhead for message structure, tool calls, and image content.

```typescript
import { estimateTokens } from '@sschepis/llm-wrapper';

const tokens = estimateTokens([
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'Write a poem about TypeScript.' },
]);
// ~15 tokens
```

### `validateContextWindow()`

Checks if messages fit within a model's known context window.

```typescript
import { validateContextWindow } from '@sschepis/llm-wrapper';

const result = validateContextWindow(messages, 'gpt-4o');
// {
//   ok: true,
//   estimatedTokens: 1500,
//   contextWindow: 128000,
//   remainingTokens: 126500,
// }

if (!result.ok) {
  console.warn(`Messages exceed context window by ${result.estimatedTokens - result.contextWindow} tokens`);
}
```

Returns `ok: true` with `contextWindow: Infinity` for unknown models.

## Message Truncation

### `truncateMessages()`

Removes messages to fit within a token budget. Preserves system messages and the most recent user message.

```typescript
import { truncateMessages } from '@sschepis/llm-wrapper';

const trimmed = truncateMessages(messages, 4000);
```

#### Options

```typescript
truncateMessages(messages, maxTokens, {
  strategy: 'oldest',    // Remove from the start (default)
  preserveSystem: true,  // Keep system messages (default true)
});

truncateMessages(messages, maxTokens, {
  strategy: 'middle',    // Remove from the middle, keep first and last
});
```

**`'oldest'` strategy** — removes the oldest non-system messages first. Good for long conversations where recent context matters most.

**`'middle'` strategy** — removes from the middle of the conversation, keeping the first message (often sets context) and the most recent exchange. Good for preserving both the original context and the latest user turn.

## Model Registry

### `getModelInfo()`

Returns metadata for a known model:

```typescript
import { getModelInfo } from '@sschepis/llm-wrapper';

const info = getModelInfo('gpt-4o');
// { contextWindow: 128000, maxOutputTokens: 16384, provider: 'openai' }

// Supports short aliases
getModelInfo('claude-sonnet-4');
// { contextWindow: 200000, maxOutputTokens: 16000, provider: 'anthropic' }
```

### `inferProvider()`

Infers the provider name from a model identifier:

```typescript
import { inferProvider } from '@sschepis/llm-wrapper';

inferProvider('gpt-4o');           // 'openai'
inferProvider('claude-sonnet-4');  // 'anthropic'
inferProvider('gemini-2.0-flash'); // 'gemini'
inferProvider('deepseek-chat');    // 'deepseek'
inferProvider('unknown-model');    // undefined
```

### `MODEL_REGISTRY`

The raw registry object, in case you need to iterate or extend it:

```typescript
import { MODEL_REGISTRY } from '@sschepis/llm-wrapper';

for (const [model, info] of Object.entries(MODEL_REGISTRY)) {
  console.log(`${model}: ${info.contextWindow} tokens (${info.provider})`);
}
```
