import { describe, it, expect } from 'vitest';
import { RoutingEngine } from '../../src/router/routing-engine.js';
import { HealthTracker } from '../../src/router/health-tracker.js';
import { CapabilityStrategy, PriorityStrategy } from '../../src/router/strategies.js';
import { LLMErrorCode } from '../../src/core/errors.js';
import type { Endpoint, EndpointState, RoutingContext } from '../../src/router/types.js';

function makeEndpoint(name: string, overrides?: Partial<Endpoint>): Endpoint {
  return { name, provider: 'openai', model: 'gpt-4o', config: { apiKey: 'test' }, ...overrides };
}

function makeContext(endpoints: Endpoint[], overrides?: Partial<RoutingContext>): RoutingContext {
  return {
    params: { model: 'auto', messages: [{ role: 'user', content: 'Hi' }] },
    endpoints: endpoints.map(e => ({ endpoint: e, health: { status: 'closed' as const, errorRate: 0, avgLatencyMs: 0, consecutiveFailures: 0, totalRequests: 0, totalErrors: 0 } })),
    attempt: 0,
    ...overrides,
  };
}

describe('RoutingEngine', () => {
  it('should route using strategy pipeline', () => {
    const tracker = new HealthTracker();
    const ep1 = makeEndpoint('a', { priority: 1 });
    const ep2 = makeEndpoint('b', { priority: 0 });
    tracker.registerEndpoint(ep1);
    tracker.registerEndpoint(ep2);

    const engine = new RoutingEngine(
      [new CapabilityStrategy(), new PriorityStrategy()],
      tracker,
    );

    const ctx = makeContext([ep1, ep2]);
    const decision = engine.route(ctx);
    expect(decision.endpoint.name).toBe('b'); // Lower priority number
  });

  it('should throw when no endpoints available', () => {
    const tracker = new HealthTracker();
    const engine = new RoutingEngine([new CapabilityStrategy()], tracker);
    const ctx = makeContext([]);

    expect(() => engine.route(ctx)).toThrow();
  });

  it('should skip circuit-broken endpoints', () => {
    const tracker = new HealthTracker({ errorThreshold: 0.5, minRequests: 1 });
    const ep1 = makeEndpoint('broken', { priority: 0 });
    const ep2 = makeEndpoint('healthy', { priority: 1 });
    tracker.registerEndpoint(ep1);
    tracker.registerEndpoint(ep2);

    // Break ep1's circuit
    const err = { message: 'fail', code: LLMErrorCode.PROVIDER_UNAVAILABLE, provider: 'test', statusCode: 500, retryable: true, name: 'LLMError' } as any;
    tracker.recordFailure('broken', err);

    const engine = new RoutingEngine([new PriorityStrategy()], tracker);
    const ctx = makeContext([ep1, ep2]);
    const decision = engine.route(ctx);
    expect(decision.endpoint.name).toBe('healthy');
  });

  it('should fall back to first available when no strategy selects', () => {
    const tracker = new HealthTracker();
    const ep = makeEndpoint('only');
    tracker.registerEndpoint(ep);

    // Strategy that never selects
    const nullStrategy = { name: 'null', select: () => null };
    const engine = new RoutingEngine([nullStrategy], tracker);

    const ctx = makeContext([ep]);
    const decision = engine.route(ctx);
    expect(decision.endpoint.name).toBe('only');
    expect(decision.reason).toContain('default');
  });
});
