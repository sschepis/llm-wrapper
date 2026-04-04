import type { BaseProvider } from '../core/base-provider.js';
import { LLMError, LLMErrorCode } from '../core/errors.js';
import { createProvider } from '../core/factory.js';
import type {
  StandardChatParams,
  StandardChatResponse,
  StandardChatChunk,
} from '../core/types.js';
import type {
  RouterConfig,
  Endpoint,
  RoutingContext,
  EndpointState,
  HealthState,
  RoutingDecision,
} from './types.js';
import { RoutingEngine } from './routing-engine.js';
import { HealthTracker } from './health-tracker.js';
import { RouterEventEmitter } from './events.js';
import { CapabilityStrategy, PriorityStrategy } from './strategies.js';

interface EndpointEntry {
  endpoint: Endpoint;
  provider: BaseProvider;
}

export class LLMRouter {
  private endpointMap = new Map<string, EndpointEntry>();
  private engine: RoutingEngine;
  private healthTracker: HealthTracker;
  private fallbackEnabled: boolean;
  private maxFallbackAttempts: number;

  /** Event emitter for observability */
  public readonly events: RouterEventEmitter;

  private constructor(
    entries: EndpointEntry[],
    engine: RoutingEngine,
    healthTracker: HealthTracker,
    events: RouterEventEmitter,
    config: RouterConfig,
  ) {
    for (const entry of entries) {
      this.endpointMap.set(entry.endpoint.name, entry);
    }
    this.engine = engine;
    this.healthTracker = healthTracker;
    this.events = events;
    this.fallbackEnabled = config.fallback ?? true;
    this.maxFallbackAttempts = config.maxFallbackAttempts ?? 3;

    // Wire up hooks to events
    if (config.hooks) {
      const h = config.hooks;
      if (h.onRoute) this.events.on('route', ({ decision, context }) => h.onRoute!(decision, context));
      if (h.onFallback) this.events.on('fallback', ({ from, to, error }) => h.onFallback!(from, to, error));
      if (h.onCircuitBreak) this.events.on('circuit:open', ({ endpoint, health }) => h.onCircuitBreak!(endpoint, health));
      if (h.onCircuitRecover) this.events.on('circuit:close', ({ endpoint }) => h.onCircuitRecover!(endpoint));
      if (h.onRequestComplete) this.events.on('request:complete', ({ endpoint, latencyMs, usage }) => h.onRequestComplete!(endpoint, latencyMs, usage));
    }
  }

  /**
   * Create a new LLMRouter. Async because provider initialization uses dynamic imports.
   */
  static async create(config: RouterConfig): Promise<LLMRouter> {
    const events = new RouterEventEmitter();
    const healthTracker = new HealthTracker(config.healthCheck, events);

    // Create provider instances for each endpoint
    const entries: EndpointEntry[] = [];
    for (const endpoint of config.endpoints) {
      const provider = await createProvider(endpoint.provider, endpoint.config as any);
      entries.push({ endpoint, provider });
      healthTracker.registerEndpoint(endpoint);
    }

    // Build strategy pipeline
    const strategies = config.strategy
      ? Array.isArray(config.strategy)
        ? config.strategy
        : [config.strategy]
      : [new CapabilityStrategy(), new PriorityStrategy()]; // defaults

    const engine = new RoutingEngine(strategies, healthTracker);

    return new LLMRouter(entries, engine, healthTracker, events, config);
  }

  /**
   * Send a chat completion, routed to the best endpoint.
   * Supports automatic fallback on failure.
   */
  async chat(params: StandardChatParams): Promise<StandardChatResponse> {
    const errors: LLMError[] = [];
    const triedEndpoints: string[] = [];

    for (let attempt = 0; attempt <= this.maxFallbackAttempts; attempt++) {
      const ctx = this.buildContext(params, attempt, errors, triedEndpoints);
      let decision: RoutingDecision;

      try {
        decision = this.engine.route(ctx);
      } catch (err) {
        // No endpoints available at all
        throw err instanceof LLMError ? err : new LLMError(
          String(err),
          LLMErrorCode.PROVIDER_UNAVAILABLE,
          'router',
        );
      }

      this.events.emit('route', { decision, context: ctx });

      const entry = this.endpointMap.get(decision.endpoint.name);
      if (!entry) {
        throw new LLMError(
          `Endpoint "${decision.endpoint.name}" not found`,
          LLMErrorCode.INVALID_REQUEST,
          'router',
        );
      }

      // Override model with the endpoint's model
      const routedParams: StandardChatParams = {
        ...params,
        model: decision.endpoint.model,
      };

      const startTime = Date.now();

      try {
        const response = await entry.provider.chat(routedParams);
        const latencyMs = Date.now() - startTime;

        this.healthTracker.recordSuccess(decision.endpoint.name, latencyMs);
        this.events.emit('request:complete', {
          endpoint: decision.endpoint,
          latencyMs,
          usage: response.usage,
        });

        return response;
      } catch (err) {
        const latencyMs = Date.now() - startTime;
        const llmError = err instanceof LLMError
          ? err
          : new LLMError(String(err), LLMErrorCode.UNKNOWN, decision.endpoint.name);

        this.healthTracker.recordFailure(decision.endpoint.name, llmError);
        this.events.emit('request:error', { endpoint: decision.endpoint, error: llmError });

        errors.push(llmError);
        triedEndpoints.push(decision.endpoint.name);

        // Should we fallback?
        if (!this.fallbackEnabled || attempt >= this.maxFallbackAttempts) {
          throw llmError;
        }

        // Check if there are untried endpoints
        const remaining = [...this.endpointMap.values()].filter(
          e => !triedEndpoints.includes(e.endpoint.name),
        );

        if (remaining.length === 0) {
          throw llmError;
        }

        // Find what we'll route to next for the fallback event
        try {
          const nextCtx = this.buildContext(params, attempt + 1, errors, triedEndpoints);
          const nextDecision = this.engine.route(nextCtx);
          this.events.emit('fallback', {
            from: decision.endpoint,
            to: nextDecision.endpoint,
            error: llmError,
            attempt: attempt + 1,
          });
        } catch {
          // Can't determine next — will throw on next iteration
        }
      }
    }

    throw new LLMError(
      `All endpoints exhausted after ${this.maxFallbackAttempts + 1} attempts`,
      LLMErrorCode.PROVIDER_UNAVAILABLE,
      'router',
    );
  }

  /**
   * Stream a chat completion from the routed endpoint.
   * Streams do NOT support fallback — partial consumption can't be replayed.
   */
  async *stream(params: StandardChatParams): AsyncIterable<StandardChatChunk> {
    const ctx = this.buildContext(params, 0, [], []);
    const decision = this.engine.route(ctx);

    this.events.emit('route', { decision, context: ctx });

    const entry = this.endpointMap.get(decision.endpoint.name);
    if (!entry) {
      throw new LLMError(
        `Endpoint "${decision.endpoint.name}" not found`,
        LLMErrorCode.INVALID_REQUEST,
        'router',
      );
    }

    const routedParams: StandardChatParams = {
      ...params,
      model: decision.endpoint.model,
    };

    const startTime = Date.now();

    try {
      yield* entry.provider.stream(routedParams);
      const latencyMs = Date.now() - startTime;
      this.healthTracker.recordSuccess(decision.endpoint.name, latencyMs);
      this.events.emit('request:complete', {
        endpoint: decision.endpoint,
        latencyMs,
      });
    } catch (err) {
      const llmError = err instanceof LLMError
        ? err
        : new LLMError(String(err), LLMErrorCode.UNKNOWN, decision.endpoint.name);
      this.healthTracker.recordFailure(decision.endpoint.name, llmError);
      this.events.emit('request:error', { endpoint: decision.endpoint, error: llmError });
      throw llmError;
    }
  }

  /**
   * Add an endpoint at runtime.
   */
  async addEndpoint(endpoint: Endpoint): Promise<void> {
    const provider = await createProvider(endpoint.provider, endpoint.config as any);
    this.endpointMap.set(endpoint.name, { endpoint, provider });
    this.healthTracker.registerEndpoint(endpoint);
  }

  /**
   * Remove an endpoint at runtime.
   */
  removeEndpoint(name: string): void {
    this.endpointMap.delete(name);
  }

  /**
   * Get current health state for all endpoints.
   */
  getHealthState(): Map<string, HealthState> {
    const result = new Map<string, HealthState>();
    for (const [name] of this.endpointMap) {
      result.set(name, this.healthTracker.getState(name));
    }
    return result;
  }

  /**
   * Reset health tracking for one or all endpoints.
   */
  resetHealth(name?: string): void {
    this.healthTracker.reset(name);
  }

  // --- Private ---

  private buildContext(
    params: StandardChatParams,
    attempt: number,
    previousErrors: LLMError[],
    previousEndpoints: string[],
  ): RoutingContext {
    const endpoints: EndpointState[] = [...this.endpointMap.values()].map(entry => ({
      endpoint: entry.endpoint,
      health: this.healthTracker.getState(entry.endpoint.name),
    }));

    return {
      params,
      endpoints,
      attempt,
      previousErrors: previousErrors.length > 0 ? previousErrors : undefined,
      previousEndpoints: previousEndpoints.length > 0 ? previousEndpoints : undefined,
    };
  }
}
