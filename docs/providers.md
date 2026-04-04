# Provider Guide

## Overview

Each provider maps between the standardized OpenAI Chat Completion format and the provider's native API. You can use providers directly or through the `UniversalLLM` factory.

## Direct Provider Usage

```typescript
import { OpenAIProvider, AnthropicProvider, GeminiProvider } from '@sschepis/llm-wrapper';

// Direct instantiation
const openai = new OpenAIProvider({ apiKey: 'sk-...' });
const anthropic = new AnthropicProvider({ apiKey: 'sk-ant-...' });
const gemini = new GeminiProvider({ apiKey: 'AIza...' });

// Same interface for all
const response = await openai.chat({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

## Provider-Specific Details

### OpenAI

The reference implementation — near pass-through since the standardized format matches OpenAI's API.

```typescript
import { OpenAIProvider } from '@sschepis/llm-wrapper';

const provider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  // baseUrl: 'https://api.openai.com/v1', // default
});
```

**Supported models:** `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `gpt-4`, `gpt-3.5-turbo`, `o1`, `o1-mini`, `o3-mini`

### Anthropic

Maps between OpenAI format and Anthropic's Messages API. Key transformations:

- System messages extracted into top-level `system` parameter
- Consecutive same-role messages merged (Anthropic requires alternating roles)
- `tool_calls` → `content: [{ type: 'tool_use', ... }]`
- `role: 'tool'` → `role: 'user'` with `tool_result` content blocks
- `max_tokens` defaults to 4096 if not specified (required by Anthropic)

```typescript
import { AnthropicProvider } from '@sschepis/llm-wrapper';

const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});
```

**Supported models:** `claude-opus-4-*`, `claude-sonnet-4-*`, `claude-3-5-sonnet-*`, `claude-3-5-haiku-*`, `claude-3-opus-*`, `claude-3-sonnet-*`, `claude-3-haiku-*`

### Gemini

Maps between OpenAI format and Google's Parts API. Key transformations:

- `role: 'assistant'` ↔ `role: 'model'`
- System messages extracted into `systemInstruction`
- Messages → `Content` with `parts: Part[]`
- Synthetic tool call IDs generated (Gemini doesn't provide them)
- Streaming: accumulated responses → deltas computed by diffing

```typescript
import { GeminiProvider } from '@sschepis/llm-wrapper';

const provider = new GeminiProvider({
  apiKey: process.env.GEMINI_API_KEY!,
});
```

**Supported models:** `gemini-2.0-flash`, `gemini-2.0-flash-lite`, `gemini-1.5-pro`, `gemini-1.5-flash`

### Vertex AI Gemini

Same as Gemini but uses Google Cloud's Vertex AI SDK with ADC (Application Default Credentials).

```typescript
import { VertexGeminiProvider } from '@sschepis/llm-wrapper';

const provider = new VertexGeminiProvider({
  apiKey: '', // Not used — auth via ADC
  projectId: 'my-gcp-project',
  location: 'us-central1', // default
});
```

**Auth:** Uses Application Default Credentials. Run `gcloud auth application-default login` or set `GOOGLE_APPLICATION_CREDENTIALS`.

### Vertex AI Anthropic

Claude models via Google Cloud's Vertex AI endpoint.

```typescript
import { VertexAnthropicProvider } from '@sschepis/llm-wrapper';

const provider = new VertexAnthropicProvider({
  apiKey: '', // Auth via ADC or service account
  projectId: 'my-gcp-project',
  location: 'us-east5',
});
```

### OpenRouter

OpenAI-compatible proxy with access to many models. Supports app identification headers.

```typescript
import { OpenRouterProvider } from '@sschepis/llm-wrapper';

const provider = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  appName: 'My App',
  appUrl: 'https://myapp.com',
});

const response = await provider.chat({
  model: 'anthropic/claude-sonnet-4', // OpenRouter model format
  messages: [{ role: 'user', content: 'Hello' }],
});
```

### DeepSeek

```typescript
import { createCompatProvider } from '@sschepis/llm-wrapper';

const provider = createCompatProvider('deepseek', {
  apiKey: process.env.DEEPSEEK_API_KEY!,
});

await provider.chat({
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

### LM Studio

Local inference server with OpenAI-compatible API.

```typescript
import { createCompatProvider } from '@sschepis/llm-wrapper';

const provider = createCompatProvider('lmstudio', {
  // apiKey defaults to 'lm-studio'
  // baseUrl defaults to 'http://localhost:1234/v1'
});

await provider.chat({
  model: 'local-model-name',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

### Ollama

Local model server with additional utilities.

```typescript
import { OllamaProvider } from '@sschepis/llm-wrapper';

const provider = new OllamaProvider({
  // baseUrl defaults to 'http://localhost:11434/v1'
});

// Ollama-specific methods
const isUp = await provider.healthCheck();
const models = await provider.listModels();

await provider.chat({
  model: 'llama3.2',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

## Configuration

All providers accept a `ProviderConfig`:

```typescript
interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;         // Override API endpoint
  maxRetries?: number;      // Default: 3
  timeout?: number;         // Default: 60000ms
  defaultModel?: string;    // Fallback model name
  headers?: Record<string, string>;  // Extra HTTP headers
  hooks?: {
    onBeforeRequest?: (params) => params;
    onAfterResponse?: (response) => void;
    onError?: (error) => void;
  };
}
```

## Writing a Custom Provider

Extend `BaseProvider` and implement three methods:

```typescript
import { BaseProvider } from '@sschepis/llm-wrapper';
import type { StandardChatParams, StandardChatResponse, StandardChatChunk } from '@sschepis/llm-wrapper';
import { LLMError, LLMErrorCode } from '@sschepis/llm-wrapper';

class MyProvider extends BaseProvider {
  public readonly providerName = 'my-provider';

  constructor(config: ProviderConfig) {
    super(config);
    // Initialize your SDK client here
  }

  protected async doChat(params: StandardChatParams): Promise<StandardChatResponse> {
    // Transform params → your API format
    // Call your API
    // Transform response → StandardChatResponse
  }

  protected async *doStream(params: StandardChatParams): AsyncIterable<StandardChatChunk> {
    // Stream from your API
    // Yield StandardChatChunk objects
  }

  protected mapError(error: unknown): LLMError {
    // Map your SDK's errors to LLMError
    return new LLMError(
      error instanceof Error ? error.message : String(error),
      LLMErrorCode.UNKNOWN,
      this.providerName,
    );
  }
}
```

Your custom provider automatically gets retry logic, hooks, and Zod validation from `BaseProvider`.
