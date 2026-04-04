import type {
  RoutingStrategy,
  RoutingContext,
  RoutingDecision,
  EndpointState,
} from './types.js';
import { estimateTokens } from '../utils/token-counter.js';
import { getModelInfo } from '../utils/model-registry.js';

/**
 * Filters out endpoints that can't handle the request's requirements.
 */
export class CapabilityStrategy implements RoutingStrategy {
  name = 'capability';

  filter(ctx: RoutingContext, candidates: EndpointState[]): EndpointState[] {
    const params = ctx.params;

    return candidates.filter(({ endpoint }) => {
      const caps = endpoint.capabilities ?? {};

      // Tools required?
      if (params.tools?.length && caps.tools === false) return false;

      // Streaming required?
      if (params.stream && caps.streaming === false) return false;

      // JSON mode required?
      if (params.response_format?.type === 'json_object' && caps.jsonMode === false) return false;

      // Vision required? Check for image content parts
      if (caps.vision === false && hasImageContent(params.messages)) return false;

      // Context window check
      const maxContext = caps.maxContextWindow ?? getModelInfo(endpoint.model)?.contextWindow;
      if (maxContext) {
        const estimated = estimateTokens(params.messages, endpoint.model);
        if (estimated > maxContext) return false;
      }

      return true;
    });
  }

  select(_ctx: RoutingContext, _candidates: EndpointState[]): RoutingDecision | null {
    // CapabilityStrategy is a filter-only strategy; selection is left to downstream strategies
    return null;
  }
}

/**
 * Selects the cheapest endpoint based on estimated token usage.
 */
export class CostStrategy implements RoutingStrategy {
  name = 'cost';

  select(ctx: RoutingContext, candidates: EndpointState[]): RoutingDecision | null {
    const withCost = candidates
      .filter(c => c.endpoint.costPer1kInput != null || c.endpoint.costPer1kOutput != null)
      .map(c => {
        const inputTokens = estimateTokens(ctx.params.messages, c.endpoint.model);
        const outputTokens = ctx.params.max_tokens ?? 1000;
        const inputCost = (inputTokens / 1000) * (c.endpoint.costPer1kInput ?? 0);
        const outputCost = (outputTokens / 1000) * (c.endpoint.costPer1kOutput ?? 0);
        return { state: c, estimatedCost: inputCost + outputCost };
      })
      .sort((a, b) => a.estimatedCost - b.estimatedCost);

    if (withCost.length === 0) return null;

    const best = withCost[0];
    return {
      endpoint: best.state.endpoint,
      reason: `cheapest (est. $${best.estimatedCost.toFixed(6)})`,
    };
  }
}

/**
 * Selects the endpoint with lowest observed average latency.
 */
export class LatencyStrategy implements RoutingStrategy {
  name = 'latency';

  select(_ctx: RoutingContext, candidates: EndpointState[]): RoutingDecision | null {
    const withLatency = candidates
      .filter(c => c.health.totalRequests > 0 && c.health.avgLatencyMs > 0)
      .sort((a, b) => a.health.avgLatencyMs - b.health.avgLatencyMs);

    if (withLatency.length === 0) return null;

    const best = withLatency[0];
    return {
      endpoint: best.endpoint,
      reason: `lowest latency (${Math.round(best.health.avgLatencyMs)}ms avg)`,
    };
  }
}

/**
 * Selects by priority (lower number = higher priority).
 * Falls back to weight for tie-breaking.
 */
export class PriorityStrategy implements RoutingStrategy {
  name = 'priority';

  select(ctx: RoutingContext, candidates: EndpointState[]): RoutingDecision | null {
    // On fallback attempts, exclude previously tried endpoints
    let available = candidates;
    if (ctx.previousEndpoints?.length) {
      available = candidates.filter(
        c => !ctx.previousEndpoints!.includes(c.endpoint.name),
      );
    }

    if (available.length === 0) return null;

    const sorted = [...available].sort((a, b) => {
      const pa = a.endpoint.priority ?? 0;
      const pb = b.endpoint.priority ?? 0;
      if (pa !== pb) return pa - pb;
      const wa = a.endpoint.weight ?? 1;
      const wb = b.endpoint.weight ?? 1;
      return wb - wa; // Higher weight preferred
    });

    return {
      endpoint: sorted[0].endpoint,
      reason: `priority ${sorted[0].endpoint.priority ?? 0}`,
    };
  }
}

/**
 * Weighted round-robin load balancing.
 */
export class LoadBalanceStrategy implements RoutingStrategy {
  name = 'load-balance';
  private counter = 0;

  select(_ctx: RoutingContext, candidates: EndpointState[]): RoutingDecision | null {
    if (candidates.length === 0) return null;

    // Build weighted pool
    const pool: EndpointState[] = [];
    for (const c of candidates) {
      const weight = c.endpoint.weight ?? 1;
      for (let i = 0; i < weight; i++) {
        pool.push(c);
      }
    }

    if (pool.length === 0) return null;

    const index = this.counter % pool.length;
    this.counter++;

    return {
      endpoint: pool[index].endpoint,
      reason: `load balance (slot ${index}/${pool.length})`,
    };
  }
}

/**
 * On fallback attempts, skips previously failed endpoints and picks by priority.
 */
export class FallbackStrategy implements RoutingStrategy {
  name = 'fallback';

  select(ctx: RoutingContext, candidates: EndpointState[]): RoutingDecision | null {
    if (ctx.attempt === 0) return null; // Only activate on retries

    const available = candidates.filter(
      c => !ctx.previousEndpoints?.includes(c.endpoint.name),
    );

    if (available.length === 0) return null;

    const sorted = [...available].sort((a, b) => {
      return (a.endpoint.priority ?? 0) - (b.endpoint.priority ?? 0);
    });

    return {
      endpoint: sorted[0].endpoint,
      reason: `fallback (attempt ${ctx.attempt + 1})`,
    };
  }
}

/**
 * User-provided custom routing function.
 */
export class CustomStrategy implements RoutingStrategy {
  name = 'custom';
  private fn: (ctx: RoutingContext, candidates: EndpointState[]) => RoutingDecision | null;

  constructor(fn: (ctx: RoutingContext, candidates: EndpointState[]) => RoutingDecision | null) {
    this.fn = fn;
  }

  select(ctx: RoutingContext, candidates: EndpointState[]): RoutingDecision | null {
    return this.fn(ctx, candidates);
  }
}

// --- Helpers ---

function hasImageContent(messages: Array<{ content: unknown }>): boolean {
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && typeof part === 'object' && 'type' in part && part.type === 'image_url') {
          return true;
        }
      }
    }
  }
  return false;
}
