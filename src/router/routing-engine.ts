import type {
  RoutingStrategy,
  RoutingContext,
  RoutingDecision,
  EndpointState,
} from './types.js';
import { HealthTracker } from './health-tracker.js';
import { LLMError, LLMErrorCode } from '../core/errors.js';

export class RoutingEngine {
  private strategies: RoutingStrategy[];
  private healthTracker: HealthTracker;

  constructor(strategies: RoutingStrategy[], healthTracker: HealthTracker) {
    this.strategies = strategies;
    this.healthTracker = healthTracker;
  }

  route(ctx: RoutingContext): RoutingDecision {
    // Start with all endpoints + their health state
    let candidates: EndpointState[] = ctx.endpoints.map(es => ({
      endpoint: es.endpoint,
      health: this.healthTracker.getState(es.endpoint.name),
    }));

    // Filter out circuit-broken endpoints
    const available = candidates.filter(c => this.healthTracker.isAvailable(c.endpoint.name));

    if (available.length > 0) {
      candidates = available;
    }
    // If ALL endpoints are broken, allow half-open probes (don't filter)
    // This prevents total deadlock — at least one will get a probe

    // Run each strategy's filter() in sequence
    for (const strategy of this.strategies) {
      if (strategy.filter) {
        candidates = strategy.filter(ctx, candidates);
        if (candidates.length === 0) break;
      }
    }

    if (candidates.length === 0) {
      throw new LLMError(
        'No endpoints available: all filtered out by routing strategies or circuit-broken',
        LLMErrorCode.PROVIDER_UNAVAILABLE,
        'router',
        undefined,
        false,
      );
    }

    // Run each strategy's select() — first non-null result wins
    for (const strategy of this.strategies) {
      const decision = strategy.select(ctx, candidates);
      if (decision) return decision;
    }

    // No strategy selected — fall back to first available
    return {
      endpoint: candidates[0].endpoint,
      reason: 'default (no strategy selected)',
    };
  }
}
