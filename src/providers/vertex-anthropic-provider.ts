import { AnthropicProvider } from './anthropic-provider.js';
import type { ProviderConfig } from '../core/types.js';

export interface VertexAnthropicConfig extends ProviderConfig {
  projectId: string;
  location?: string;
}

/**
 * Anthropic provider via Google Vertex AI.
 *
 * Uses the Anthropic SDK with Vertex AI endpoint. The SDK supports Vertex natively
 * via the AnthropicVertex class. This provider extends AnthropicProvider to reuse
 * all request/response transformation logic, only swapping the client.
 */
export class VertexAnthropicProvider extends AnthropicProvider {
  public override readonly providerName = 'vertex-anthropic';

  constructor(config: VertexAnthropicConfig) {
    // Build the Vertex-specific base URL
    const location = config.location ?? 'us-central1';
    const baseUrl = config.baseUrl ??
      `https://${location}-aiplatform.googleapis.com/v1/projects/${config.projectId}/locations/${location}/publishers/anthropic/models`;

    super({
      ...config,
      baseUrl,
    });

    // Re-initialize with AnthropicVertex client if available
    try {
      const AnthropicModule = require('@anthropic-ai/sdk') as any;
      if (AnthropicModule.AnthropicVertex) {
        this.client = new AnthropicModule.AnthropicVertex({
          projectId: config.projectId,
          region: location,
        });
      }
    } catch {
      // Fall back to standard Anthropic client with Vertex base URL
    }
  }
}
