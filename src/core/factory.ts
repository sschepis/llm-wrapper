import type { BaseProvider } from './base-provider.js';
import type { ProviderConfig, StandardChatParams, StandardChatResponse, StandardChatChunk } from './types.js';

export type ProviderName =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'vertex-gemini'
  | 'vertex-anthropic'
  | 'openrouter'
  | 'deepseek'
  | 'lmstudio'
  | 'ollama';

export interface UniversalLLMConfig extends ProviderConfig {
  provider: ProviderName;
  // Vertex-specific
  projectId?: string;
  location?: string;
  // OpenRouter-specific
  appName?: string;
  appUrl?: string;
}

/**
 * Create a provider instance by name. Uses dynamic imports to avoid
 * loading unused SDK bundles.
 */
export async function createProvider(provider: ProviderName, config: ProviderConfig & Record<string, unknown>): Promise<BaseProvider> {
  switch (provider) {
    case 'openai': {
      const { OpenAIProvider } = await import('../providers/openai-provider.js');
      return new OpenAIProvider(config);
    }
    case 'anthropic': {
      const { AnthropicProvider } = await import('../providers/anthropic-provider.js');
      return new AnthropicProvider(config);
    }
    case 'gemini': {
      const { GeminiProvider } = await import('../providers/gemini-provider.js');
      return new GeminiProvider(config);
    }
    case 'vertex-gemini': {
      const { VertexGeminiProvider } = await import('../providers/vertex-gemini-provider.js');
      return new VertexGeminiProvider({
        ...config,
        projectId: config.projectId as string,
        location: config.location as string | undefined,
      });
    }
    case 'vertex-anthropic': {
      const { VertexAnthropicProvider } = await import('../providers/vertex-anthropic-provider.js');
      return new VertexAnthropicProvider({
        ...config,
        projectId: config.projectId as string,
        location: config.location as string | undefined,
      });
    }
    case 'openrouter': {
      const { OpenRouterProvider } = await import('../providers/openai-compat.js');
      return new OpenRouterProvider(config as any);
    }
    case 'deepseek':
    case 'lmstudio':
    case 'ollama': {
      const { createCompatProvider } = await import('../providers/openai-compat.js');
      return createCompatProvider(provider, config);
    }
    default:
      throw new Error(`Unknown provider: "${provider}". Available: openai, anthropic, gemini, vertex-gemini, vertex-anthropic, openrouter, deepseek, lmstudio, ollama`);
  }
}

/**
 * High-level unified LLM client. Wraps provider creation and exposes
 * a simple chat/stream interface.
 */
export class UniversalLLM {
  private provider: BaseProvider;

  private constructor(provider: BaseProvider) {
    this.provider = provider;
  }

  /**
   * Create a new UniversalLLM instance.
   * Async because provider loading uses dynamic imports.
   */
  static async create(options: UniversalLLMConfig): Promise<UniversalLLM> {
    const { provider: providerName, ...config } = options;
    const provider = await createProvider(providerName, config as any);
    return new UniversalLLM(provider);
  }

  /**
   * Send a chat completion request.
   */
  async chat(params: StandardChatParams): Promise<StandardChatResponse> {
    return this.provider.chat(params);
  }

  /**
   * Stream a chat completion.
   */
  stream(params: StandardChatParams): AsyncIterable<StandardChatChunk> {
    return this.provider.stream(params);
  }
}
