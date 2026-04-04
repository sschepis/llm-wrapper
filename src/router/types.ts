import type { ProviderName } from '../core/factory.js';
import type {
  ProviderConfig,
  StandardChatParams,
  StandardChatResponse,
  Usage,
} from '../core/types.js';
import type { LLMError } from '../core/errors.js';

// --- Endpoint ---

export interface EndpointCapabilities {
  streaming?: boolean;
  tools?: boolean;
  vision?: boolean;
  jsonMode?: boolean;
  maxContextWindow?: number;
  maxOutputTokens?: number;
}

export interface Endpoint {
  /** User-defined label, e.g. "fast-claude" */
  name: string;
  /** Provider type */
  provider: ProviderName;
  /** Model identifier */
  model: string;
  /** Provider configuration (apiKey, baseUrl, etc.) */
  config: ProviderConfig;
  /** Lower = preferred. Default 0 */
  priority?: number;
  /** For weighted load balancing. Default 1 */
  weight?: number;
  /** Cost per 1k input tokens (USD) */
  costPer1kInput?: number;
  /** Cost per 1k output tokens (USD) */
  costPer1kOutput?: number;
  /** Capability declarations */
  capabilities?: EndpointCapabilities;
  /** User-defined tags for custom routing */
  tags?: string[];
}

// --- Health ---

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface HealthState {
  status: CircuitState;
  errorRate: number;
  avgLatencyMs: number;
  lastErrorTime?: number;
  lastSuccessTime?: number;
  consecutiveFailures: number;
  totalRequests: number;
  totalErrors: number;
}

export interface HealthCheckConfig {
  /** Enable health tracking. Default true */
  enabled?: boolean;
  /** Rolling window size in ms. Default 60000 */
  windowSize?: number;
  /** Error rate (0-1) to trip circuit. Default 0.5 */
  errorThreshold?: number;
  /** Cooldown before half-open retry in ms. Default 30000 */
  cooldownMs?: number;
  /** Minimum requests before circuit can trip. Default 5 */
  minRequests?: number;
}

// --- Routing ---

export interface EndpointState {
  endpoint: Endpoint;
  health: HealthState;
}

export interface RoutingContext {
  params: StandardChatParams;
  endpoints: EndpointState[];
  attempt: number;
  previousErrors?: LLMError[];
  previousEndpoints?: string[];
  metadata?: Record<string, unknown>;
}

export interface RoutingDecision {
  endpoint: Endpoint;
  reason: string;
}

export interface RoutingStrategy {
  name: string;
  /** Filter out endpoints that can't handle the request */
  filter?(ctx: RoutingContext, candidates: EndpointState[]): EndpointState[];
  /** Select the best endpoint from candidates */
  select(ctx: RoutingContext, candidates: EndpointState[]): RoutingDecision | null;
}

// --- Router Configuration ---

export interface RouterHooks {
  onRoute?: (decision: RoutingDecision, ctx: RoutingContext) => void;
  onFallback?: (from: Endpoint, to: Endpoint, error: LLMError) => void;
  onCircuitBreak?: (endpoint: Endpoint, health: HealthState) => void;
  onCircuitRecover?: (endpoint: Endpoint) => void;
  onRequestComplete?: (endpoint: Endpoint, latencyMs: number, usage?: Usage) => void;
}

export interface RouterConfig {
  endpoints: Endpoint[];
  /** Single strategy or pipeline of strategies */
  strategy?: RoutingStrategy | RoutingStrategy[];
  /** Try next endpoint on failure. Default true */
  fallback?: boolean;
  /** Max fallback attempts. Default 3 */
  maxFallbackAttempts?: number;
  /** Health check / circuit breaker config */
  healthCheck?: HealthCheckConfig;
  /** Router lifecycle hooks */
  hooks?: RouterHooks;
}
