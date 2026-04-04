import type { ModelInfo } from '../core/types.js';

export const MODEL_REGISTRY: Record<string, ModelInfo> = {
  // OpenAI
  'gpt-4o': { contextWindow: 128_000, maxOutputTokens: 16_384, provider: 'openai' },
  'gpt-4o-mini': { contextWindow: 128_000, maxOutputTokens: 16_384, provider: 'openai' },
  'gpt-4-turbo': { contextWindow: 128_000, maxOutputTokens: 4_096, provider: 'openai' },
  'gpt-4': { contextWindow: 8_192, maxOutputTokens: 4_096, provider: 'openai' },
  'gpt-3.5-turbo': { contextWindow: 16_385, maxOutputTokens: 4_096, provider: 'openai' },
  'o1': { contextWindow: 200_000, maxOutputTokens: 100_000, provider: 'openai' },
  'o1-mini': { contextWindow: 128_000, maxOutputTokens: 65_536, provider: 'openai' },
  'o3-mini': { contextWindow: 200_000, maxOutputTokens: 100_000, provider: 'openai' },

  // Anthropic
  'claude-opus-4-20250514': { contextWindow: 200_000, maxOutputTokens: 32_000, provider: 'anthropic' },
  'claude-sonnet-4-20250514': { contextWindow: 200_000, maxOutputTokens: 16_000, provider: 'anthropic' },
  'claude-3-5-sonnet-20241022': { contextWindow: 200_000, maxOutputTokens: 8_192, provider: 'anthropic' },
  'claude-3-5-haiku-20241022': { contextWindow: 200_000, maxOutputTokens: 8_192, provider: 'anthropic' },
  'claude-3-opus-20240229': { contextWindow: 200_000, maxOutputTokens: 4_096, provider: 'anthropic' },
  'claude-3-sonnet-20240229': { contextWindow: 200_000, maxOutputTokens: 4_096, provider: 'anthropic' },
  'claude-3-haiku-20240307': { contextWindow: 200_000, maxOutputTokens: 4_096, provider: 'anthropic' },

  // Gemini
  'gemini-2.0-flash': { contextWindow: 1_048_576, maxOutputTokens: 8_192, provider: 'gemini' },
  'gemini-2.0-flash-lite': { contextWindow: 1_048_576, maxOutputTokens: 8_192, provider: 'gemini' },
  'gemini-1.5-pro': { contextWindow: 2_097_152, maxOutputTokens: 8_192, provider: 'gemini' },
  'gemini-1.5-flash': { contextWindow: 1_048_576, maxOutputTokens: 8_192, provider: 'gemini' },

  // DeepSeek
  'deepseek-chat': { contextWindow: 64_000, maxOutputTokens: 8_192, provider: 'deepseek' },
  'deepseek-coder': { contextWindow: 64_000, maxOutputTokens: 8_192, provider: 'deepseek' },
  'deepseek-reasoner': { contextWindow: 64_000, maxOutputTokens: 8_192, provider: 'deepseek' },
};

// Alias mappings for short names
const ALIASES: Record<string, string> = {
  'claude-opus-4': 'claude-opus-4-20250514',
  'claude-sonnet-4': 'claude-sonnet-4-20250514',
  'claude-3-5-sonnet': 'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku': 'claude-3-5-haiku-20241022',
  'claude-3-opus': 'claude-3-opus-20240229',
  'claude-3-sonnet': 'claude-3-sonnet-20240229',
  'claude-3-haiku': 'claude-3-haiku-20240307',
};

export function getModelInfo(model: string): ModelInfo | undefined {
  return MODEL_REGISTRY[model] ?? MODEL_REGISTRY[ALIASES[model] ?? ''];
}

export function inferProvider(model: string): string | undefined {
  const info = getModelInfo(model);
  if (info) return info.provider;

  // Heuristic fallback
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) return 'openai';
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gemini-')) return 'gemini';
  if (model.startsWith('deepseek-')) return 'deepseek';

  return undefined;
}
