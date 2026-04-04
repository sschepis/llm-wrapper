import { OpenAIProvider } from './openai-provider.js';
import type { ProviderConfig } from '../core/types.js';

export interface CompatPreset {
  baseUrl: string;
  defaultApiKey?: string;
  headers?: Record<string, string>;
  defaultModel?: string;
}

export const COMPAT_PRESETS: Record<string, CompatPreset> = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
  },
  lmstudio: {
    baseUrl: 'http://localhost:1234/v1',
    defaultApiKey: 'lm-studio',
  },
  ollama: {
    baseUrl: 'http://localhost:11434/v1',
    defaultApiKey: 'ollama',
  },
};

/**
 * Create an OpenAI-compatible provider with a named preset.
 * The preset provides baseUrl and defaults; user config overrides.
 */
export function createCompatProvider(preset: string, config: Partial<ProviderConfig> & { apiKey?: string }): OpenAIProvider {
  const presetConfig = COMPAT_PRESETS[preset];
  if (!presetConfig) {
    throw new Error(`Unknown compat preset: "${preset}". Available: ${Object.keys(COMPAT_PRESETS).join(', ')}`);
  }

  const mergedConfig: ProviderConfig = {
    apiKey: config.apiKey ?? presetConfig.defaultApiKey ?? '',
    baseUrl: config.baseUrl ?? presetConfig.baseUrl,
    defaultModel: config.defaultModel ?? presetConfig.defaultModel,
    headers: { ...presetConfig.headers, ...config.headers },
    maxRetries: config.maxRetries,
    timeout: config.timeout,
    hooks: config.hooks,
  };

  return new OpenAIProvider(mergedConfig);
}

/**
 * OpenRouter provider with extra header support for app identification.
 */
export class OpenRouterProvider extends OpenAIProvider {
  public override readonly providerName = 'openrouter';

  constructor(config: ProviderConfig & { appName?: string; appUrl?: string }) {
    const headers: Record<string, string> = { ...config.headers };
    if (config.appName) headers['X-Title'] = config.appName;
    if (config.appUrl) headers['HTTP-Referer'] = config.appUrl;

    super({
      ...config,
      baseUrl: config.baseUrl ?? 'https://openrouter.ai/api/v1',
      headers,
    });
  }
}

/**
 * Ollama provider with health check support.
 */
export class OllamaProvider extends OpenAIProvider {
  public override readonly providerName = 'ollama';
  private ollamaBaseUrl: string;

  constructor(config: Partial<ProviderConfig> & { baseUrl?: string }) {
    const baseUrl = config.baseUrl ?? 'http://localhost:11434/v1';
    super({
      apiKey: config.apiKey ?? 'ollama',
      ...config,
      baseUrl,
    });
    this.ollamaBaseUrl = baseUrl.replace(/\/v1\/?$/, '');
  }

  /**
   * Check if Ollama server is reachable.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(this.ollamaBaseUrl);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * List available models on the Ollama server.
   */
  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.ollamaBaseUrl}/api/tags`);
    if (!response.ok) throw new Error(`Ollama API error: ${response.status}`);
    const data = await response.json() as { models: Array<{ name: string }> };
    return data.models.map(m => m.name);
  }
}
