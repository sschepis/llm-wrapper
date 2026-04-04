# Architecture

## Design Philosophy

The library follows the principle of a "Smart Conduit" — it doesn't just map types between providers, it handles the boring-but-hard parts of LLM integration: retries, error normalization, streaming, token management, and intelligent routing.

**Protocol:** OpenAI's `v1/chat/completions` format is the internal lingua franca. All providers transform to/from this format.

## Core Patterns

### Adapter Pattern

Each provider is an adapter that maps between the standardized OpenAI format and the provider's native API:

```
StandardChatParams → [Provider Adapter] → Native API Call
Native Response    → [Provider Adapter] → StandardChatResponse
```

### Template Method Pattern

`BaseProvider` implements the public `chat()` and `stream()` methods as final (non-abstract). These handle validation, hooks, and retries, then delegate to abstract `doChat()` and `doStream()` methods that each provider implements:

```
chat(params)
  → validateParams(params)        // Zod validation
  → applyBeforeHook(params)       // User hook
  → executeWithRetry(doChat)      // Retry logic
  → onAfterResponse(response)     // User hook
  → return response
```

This guarantees retry logic and hooks always execute regardless of provider.

### Provider Categories

**Full Providers** — unique API, dedicated mapper class:
- `OpenAIProvider` — near pass-through (reference implementation)
- `AnthropicProvider` — Maps Messages API (system extraction, tool_use blocks, alternating messages)
- `GeminiProvider` — Maps Parts API (role mapping, synthetic tool IDs, delta computation)

**Vertex Wrappers** — reuse mapper logic, swap SDK client:
- `VertexGeminiProvider` — uses `@google-cloud/vertexai` SDK
- `VertexAnthropicProvider` — uses Anthropic SDK with Vertex endpoint

**OpenAI-Compatible** — presets on `OpenAIProvider`:
- OpenRouter, DeepSeek, LM Studio, Ollama
- Configured via `baseUrl` and default headers
- Extensible: `OpenRouterProvider` and `OllamaProvider` are subclasses with extra methods

## Type System

All types are defined as Zod schemas in `src/core/types.ts`. TypeScript types are derived via `z.infer<>`:

```typescript
export const MessageSchema = z.object({ ... });
export type Message = z.infer<typeof MessageSchema>;
```

This provides both compile-time type safety and runtime validation (used in `BaseProvider.validateParams()`).

The `StandardChatParams` schema uses `.passthrough()` to allow provider-specific parameters to flow through without breaking validation.

## Error Handling

All provider-specific errors are mapped to `LLMError` with a unified `LLMErrorCode` enum. Each provider implements `mapError()` to translate native SDK errors:

```
OpenAI APIError(429)       → LLMError(RATE_LIMIT, retryable: true)
Anthropic APIError(401)    → LLMError(INVALID_API_KEY, retryable: false)
Gemini "quota exceeded"    → LLMError(RATE_LIMIT, retryable: true)
```

The `retryable` flag controls whether `BaseProvider`'s retry logic will attempt the request again.

## Retry Strategy

- Exponential backoff with jitter: `min(1000 * 2^attempt, 30000) * random(0.5, 1.0)`
- Only retries errors with `retryable: true` (429, 5xx)
- Default 3 retries, configurable via `maxRetries`
- **Streams are NOT retried** — partial consumption can't be replayed

## Streaming

Every provider implements streaming via `AsyncIterable<StandardChatChunk>`. The chunk format matches OpenAI's streaming format:

```typescript
interface StandardChatChunk {
  id: string;
  object: 'chat.completion.chunk';
  choices: [{
    delta: { role?, content?, tool_calls? };
    finish_reason: string | null;
  }];
}
```

Provider-specific streaming differences:
- **Anthropic** emits typed events (`content_block_delta`, etc.) → assembled into chunks
- **Gemini** emits accumulated responses → deltas computed by diffing consecutive responses

## Factory & Dynamic Imports

`createProvider()` uses dynamic `import()` to load only the requested provider module. This avoids loading all SDK dependencies at startup:

```typescript
case 'anthropic': {
  const { AnthropicProvider } = await import('../providers/anthropic-provider.js');
  return new AnthropicProvider(config);
}
```

This is why `createProvider()` and `UniversalLLM.create()` are async.

## Router Architecture

The router is a layer above providers:

```
LLMRouter
  → RoutingEngine (strategy pipeline)
    → HealthTracker (circuit breaker per endpoint)
    → Strategy[].filter() → Strategy[].select()
  → Provider.chat() / .stream()
```

### Strategy Pipeline

Strategies compose in a pipeline. Each can `filter()` (remove candidates) and/or `select()` (pick the best):

1. Filter out circuit-broken endpoints
2. Run each strategy's `filter()` in sequence
3. Run each strategy's `select()` — first non-null wins
4. Fallback: first remaining candidate

### Circuit Breaker

Per-endpoint health tracking using time-bucketed rolling windows:

```
Window = 60s, divided into 6 buckets of 10s each
Each bucket: { requests, errors, totalLatencyMs }
Old buckets expire automatically
```

State machine:
```
CLOSED → (error rate > threshold) → OPEN
OPEN   → (cooldown elapsed)       → HALF-OPEN
HALF-OPEN → (probe succeeds)      → CLOSED
HALF-OPEN → (probe fails)         → OPEN
```

### Fallback

On chat failure, the router:
1. Records failure in health tracker
2. Adds the failed endpoint to `previousEndpoints`
3. Re-routes with `attempt + 1` — strategies see this and skip failed endpoints
4. Repeats until success or `maxFallbackAttempts` exhausted

Streams do NOT fallback (partial consumption can't be replayed).
