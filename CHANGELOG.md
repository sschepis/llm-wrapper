# Changelog

## 0.1.0 (2025-04-03)

Initial release.

### Features

- **9 providers** — OpenAI, Anthropic, Gemini, Vertex AI (Gemini + Anthropic), OpenRouter, DeepSeek, LM Studio, Ollama
- **Standardized interface** — OpenAI Chat Completion format as the internal schema
- **Streaming** — full streaming support via `AsyncIterable<StandardChatChunk>`
- **Tool use** — unified function calling across all providers
- **Type safety** — Zod schemas with inferred TypeScript types
- **Retry logic** — exponential backoff with jitter for rate limits and server errors
- **Hooks** — `onBeforeRequest`, `onAfterResponse`, `onError` lifecycle hooks
- **Intelligent router** — `LLMRouter` with strategy-based endpoint selection
  - Built-in strategies: Capability, Cost, Latency, Priority, LoadBalance, Fallback, Custom
  - Circuit breaker with configurable thresholds and cooldowns
  - Automatic fallback chains on failure
  - Typed event emitter for observability
- **Utilities** — stream aggregation, token estimation, context window validation, message truncation
- **Model registry** — metadata for common models (context windows, output limits, provider inference)
- **Dual format** — ships ESM and CJS with TypeScript declarations
