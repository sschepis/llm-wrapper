# @sschepis/llm-wrapper

A unified TypeScript library for interacting with multiple LLM providers through a single, standardized OpenAI-compatible interface. Switch providers with one line — get retries, streaming, tool use, and intelligent routing for free.

## Features

- **9 providers** — OpenAI, Anthropic, Gemini, Vertex AI (Gemini + Anthropic), OpenRouter, DeepSeek, LM Studio, Ollama
- **Standardized interface** — OpenAI Chat Completion format as the lingua franca
- **Intelligent routing** — cost-based, latency-based, capability matching, load balancing, fallback chains
- **Circuit breaker** — automatic health tracking with configurable thresholds and cooldowns
- **Streaming** — full streaming support with `AsyncIterable<StandardChatChunk>`
- **Tool use** — unified tool calling across all providers
- **Type-safe** — Zod schemas with inferred TypeScript types
- **Lightweight** — provider SDKs are optional peer dependencies; install only what you use
- **Dual format** — ships ESM and CJS with full type declarations

## Installation

```bash
npm install @sschepis/llm-wrapper

# Install only the provider SDKs you need
npm install openai                  # OpenAI, OpenRouter, DeepSeek, LM Studio, Ollama
npm install @anthropic-ai/sdk       # Anthropic, Vertex Anthropic
npm install @google/generative-ai   # Gemini
npm install @google-cloud/vertexai  # Vertex Gemini, Vertex Anthropic
```

## Quick Start

### Single Provider

```typescript
import { UniversalLLM } from '@sschepis/llm-wrapper';

const client = await UniversalLLM.create({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const response = await client.chat({
  model: 'claude-sonnet-4-20250514',
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(response.choices[0].message.content);
```

### Multi-Provider Router

```typescript
import { LLMRouter, CostStrategy, CapabilityStrategy } from '@sschepis/llm-wrapper';

const router = await LLMRouter.create({
  endpoints: [
    {
      name: 'claude',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      config: { apiKey: process.env.ANTHROPIC_API_KEY! },
      costPer1kInput: 0.003,
      costPer1kOutput: 0.015,
      priority: 0,
    },
    {
      name: 'gpt',
      provider: 'openai',
      model: 'gpt-4o',
      config: { apiKey: process.env.OPENAI_API_KEY! },
      costPer1kInput: 0.0025,
      costPer1kOutput: 0.01,
      priority: 1,
    },
    {
      name: 'gemini',
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      config: { apiKey: process.env.GEMINI_API_KEY! },
      costPer1kInput: 0.0001,
      costPer1kOutput: 0.0004,
      priority: 2,
    },
  ],
  strategy: [new CapabilityStrategy(), new CostStrategy()],
});

// Router picks the best endpoint automatically
const response = await router.chat({
  model: 'auto',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

### Streaming

```typescript
for await (const chunk of client.stream({
  model: 'claude-sonnet-4-20250514',
  messages: [{ role: 'user', content: 'Tell me a story' }],
})) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
```

### Tool Use

```typescript
const response = await client.chat({
  model: 'claude-sonnet-4-20250514',
  messages: [{ role: 'user', content: 'What is the weather in NYC?' }],
  tools: [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a city',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string' },
        },
        required: ['city'],
      },
    },
  }],
});

if (response.choices[0].finish_reason === 'tool_calls') {
  const toolCall = response.choices[0].message.tool_calls![0];
  console.log(toolCall.function.name);       // 'get_weather'
  console.log(toolCall.function.arguments);  // '{"city":"NYC"}'
}
```

## Supported Providers

| Provider | Provider Name | SDK Required | Notes |
|---|---|---|---|
| OpenAI | `openai` | `openai` | Reference implementation |
| Anthropic | `anthropic` | `@anthropic-ai/sdk` | Full Messages API mapping |
| Google Gemini | `gemini` | `@google/generative-ai` | Parts API mapping |
| Vertex AI Gemini | `vertex-gemini` | `@google-cloud/vertexai` | Uses ADC auth |
| Vertex AI Anthropic | `vertex-anthropic` | `@anthropic-ai/sdk` | Claude via Vertex |
| OpenRouter | `openrouter` | `openai` | OpenAI-compatible |
| DeepSeek | `deepseek` | `openai` | OpenAI-compatible |
| LM Studio | `lmstudio` | `openai` | Local, OpenAI-compatible |
| Ollama | `ollama` | `openai` | Local, OpenAI-compatible |

### Local Providers

```typescript
// Ollama (default: localhost:11434)
const client = await UniversalLLM.create({
  provider: 'ollama',
  apiKey: 'ollama',
  // baseUrl: 'http://localhost:11434/v1', // default
});

// LM Studio (default: localhost:1234)
const client = await UniversalLLM.create({
  provider: 'lmstudio',
  apiKey: 'lm-studio',
});
```

## Router

The `LLMRouter` sits between your application and multiple provider endpoints, selecting the best one per request.

### Routing Strategies

| Strategy | Type | Description |
|---|---|---|
| `CapabilityStrategy` | Filter | Removes endpoints that can't handle the request (tools, vision, context) |
| `CostStrategy` | Select | Picks the cheapest endpoint based on estimated token cost |
| `LatencyStrategy` | Select | Picks the endpoint with lowest observed latency |
| `PriorityStrategy` | Select | Picks by priority number (lower = better), skips failed on fallback |
| `LoadBalanceStrategy` | Select | Weighted round-robin distribution |
| `FallbackStrategy` | Select | On retries, skips previously failed endpoints |
| `CustomStrategy` | Select | Wraps a user-provided function |

Strategies compose into a pipeline. Filters run first, then selectors — first non-null result wins.

### Circuit Breaker

The router tracks health per endpoint with a circuit breaker:

- **Closed** (healthy) — requests flow normally, error rate tracked in rolling window
- **Open** (broken) — requests skip this endpoint; transitions to half-open after cooldown
- **Half-open** — allows one probe request; success closes, failure re-opens

```typescript
const router = await LLMRouter.create({
  endpoints: [...],
  healthCheck: {
    windowSize: 60_000,     // 60s rolling window
    errorThreshold: 0.5,    // Trip at 50% error rate
    cooldownMs: 30_000,     // 30s before half-open probe
    minRequests: 5,         // Need 5+ requests before tripping
  },
});
```

### Observability

```typescript
router.events.on('route', ({ decision }) => {
  console.log(`Routed to ${decision.endpoint.name}: ${decision.reason}`);
});

router.events.on('fallback', ({ from, to, error }) => {
  console.warn(`Fallback: ${from.name} → ${to.name} (${error.code})`);
});

router.events.on('circuit:open', ({ endpoint }) => {
  alert(`Circuit breaker opened for ${endpoint.name}`);
});

router.events.on('request:complete', ({ endpoint, latencyMs, usage }) => {
  metrics.record(endpoint.name, latencyMs, usage?.total_tokens);
});
```

## Utilities

### Stream Aggregation

```typescript
import { aggregateStream, teeStream } from '@sschepis/llm-wrapper';

// Collect stream into final response
const response = await aggregateStream(client.stream({ ... }));

// Yield chunks AND get final response
const { chunks, result } = teeStream(client.stream({ ... }));
for await (const chunk of chunks) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
const final = await result;
```

### Token Estimation

```typescript
import { estimateTokens, validateContextWindow } from '@sschepis/llm-wrapper';

const tokens = estimateTokens(messages);
const { ok, remainingTokens } = validateContextWindow(messages, 'gpt-4o');
```

### Message Truncation

```typescript
import { truncateMessages } from '@sschepis/llm-wrapper';

const trimmed = truncateMessages(messages, 4000, {
  strategy: 'oldest',    // or 'middle'
  preserveSystem: true,  // keep system messages
});
```

## Hooks

```typescript
const client = await UniversalLLM.create({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  hooks: {
    onBeforeRequest: (params) => {
      console.log(`Sending ${params.messages.length} messages to ${params.model}`);
      return params;
    },
    onAfterResponse: (response) => {
      console.log(`Used ${response.usage.total_tokens} tokens`);
    },
    onError: (error) => {
      console.error(`LLM error: ${error.message}`);
    },
  },
});
```

## Error Handling

All provider errors are normalized into `LLMError` with unified error codes:

```typescript
import { LLMError, LLMErrorCode } from '@sschepis/llm-wrapper';

try {
  await client.chat({ ... });
} catch (err) {
  if (err instanceof LLMError) {
    switch (err.code) {
      case LLMErrorCode.RATE_LIMIT:       // 429 — retried automatically
      case LLMErrorCode.CONTEXT_EXCEEDED: // Message too long for model
      case LLMErrorCode.INVALID_API_KEY:  // 401
      case LLMErrorCode.MODEL_NOT_FOUND:  // 404
      case LLMErrorCode.PROVIDER_UNAVAILABLE: // 5xx — retried automatically
      case LLMErrorCode.CONTENT_FILTER:   // Safety filter triggered
    }
    console.log(err.provider);   // 'openai', 'anthropic', etc.
    console.log(err.statusCode); // HTTP status code
    console.log(err.retryable);  // Whether it was retried
  }
}
```

## Architecture

```
@sschepis/llm-wrapper
├── core/
│   ├── types.ts          — Zod schemas + TypeScript types (OpenAI format)
│   ├── errors.ts         — LLMError + unified error codes
│   ├── base-provider.ts  — Abstract class: retry, hooks, validation
│   └── factory.ts        — createProvider(), UniversalLLM
├── providers/
│   ├── openai-provider.ts      — Reference implementation
│   ├── anthropic-provider.ts   — Messages API mapper
│   ├── gemini-provider.ts      — Parts API mapper
│   ├── vertex-gemini-provider.ts
│   ├── vertex-anthropic-provider.ts
│   └── openai-compat.ts        — OpenRouter, DeepSeek, LM Studio, Ollama
├── router/
│   ├── router.ts         — LLMRouter (routing + fallback + health)
│   ├── routing-engine.ts — Strategy pipeline
│   ├── strategies.ts     — 7 built-in strategies
│   ├── health-tracker.ts — Circuit breaker
│   ├── events.ts         — Typed event emitter
│   └── types.ts          — Router types
└── utils/
    ├── token-counter.ts      — Token estimation
    ├── stream-aggregator.ts  — Stream → response
    ├── model-registry.ts     — Model metadata
    └── truncation.ts         — Message truncation
```

## Development

```bash
pnpm install
pnpm build        # Build ESM + CJS + types
pnpm test         # Run tests
pnpm test:watch   # Watch mode
pnpm typecheck    # Type checking only
```

## License

MIT
