import { describe, it, expect } from 'vitest';
import {
  CapabilityStrategy,
  CostStrategy,
  LatencyStrategy,
  PriorityStrategy,
  LoadBalanceStrategy,
  FallbackStrategy,
  CustomStrategy,
} from '../../src/router/strategies.js';
import type { EndpointState, RoutingContext, Endpoint } from '../../src/router/types.js';
import type { StandardChatParams } from '../../src/core/types.js';

function makeEndpointState(overrides: Partial<Endpoint> & { name: string }): EndpointState {
  return {
    endpoint: {
      provider: 'openai',
      model: 'gpt-4o',
      config: { apiKey: 'test' },
      ...overrides,
    },
    health: {
      status: 'closed',
      errorRate: 0,
      avgLatencyMs: 100,
      consecutiveFailures: 0,
      totalRequests: 10,
      totalErrors: 0,
    },
  };
}

function makeContext(params?: Partial<StandardChatParams>, ctx?: Partial<RoutingContext>): RoutingContext {
  return {
    params: {
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello' }],
      ...params,
    },
    endpoints: [],
    attempt: 0,
    ...ctx,
  };
}

describe('CapabilityStrategy', () => {
  const strategy = new CapabilityStrategy();

  it('should filter out endpoints without tool support', () => {
    const candidates = [
      makeEndpointState({ name: 'a', capabilities: { tools: false } }),
      makeEndpointState({ name: 'b', capabilities: { tools: true } }),
    ];
    const ctx = makeContext({ tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: {} } }] });
    const result = strategy.filter!(ctx, candidates);
    expect(result).toHaveLength(1);
    expect(result[0].endpoint.name).toBe('b');
  });

  it('should filter out endpoints without vision support', () => {
    const candidates = [
      makeEndpointState({ name: 'a', capabilities: { vision: false } }),
      makeEndpointState({ name: 'b' }), // no explicit caps = allowed
    ];
    const ctx = makeContext({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://img.png' } }] }],
    });
    const result = strategy.filter!(ctx, candidates);
    expect(result).toHaveLength(1);
    expect(result[0].endpoint.name).toBe('b');
  });

  it('should pass through when no special requirements', () => {
    const candidates = [
      makeEndpointState({ name: 'a' }),
      makeEndpointState({ name: 'b' }),
    ];
    const ctx = makeContext();
    const result = strategy.filter!(ctx, candidates);
    expect(result).toHaveLength(2);
  });
});

describe('CostStrategy', () => {
  const strategy = new CostStrategy();

  it('should select cheapest endpoint', () => {
    const candidates = [
      makeEndpointState({ name: 'expensive', costPer1kInput: 0.01, costPer1kOutput: 0.03 }),
      makeEndpointState({ name: 'cheap', costPer1kInput: 0.001, costPer1kOutput: 0.002 }),
    ];
    const ctx = makeContext();
    const decision = strategy.select(ctx, candidates);
    expect(decision).not.toBeNull();
    expect(decision!.endpoint.name).toBe('cheap');
  });

  it('should return null if no endpoints have cost data', () => {
    const candidates = [makeEndpointState({ name: 'a' })];
    const decision = strategy.select(makeContext(), candidates);
    expect(decision).toBeNull();
  });
});

describe('LatencyStrategy', () => {
  const strategy = new LatencyStrategy();

  it('should select lowest latency endpoint', () => {
    const candidates = [
      { ...makeEndpointState({ name: 'slow' }), health: { ...makeEndpointState({ name: 'slow' }).health, avgLatencyMs: 500, totalRequests: 10 } },
      { ...makeEndpointState({ name: 'fast' }), health: { ...makeEndpointState({ name: 'fast' }).health, avgLatencyMs: 50, totalRequests: 10 } },
    ];
    const decision = strategy.select(makeContext(), candidates);
    expect(decision!.endpoint.name).toBe('fast');
  });
});

describe('PriorityStrategy', () => {
  const strategy = new PriorityStrategy();

  it('should select by priority (lower = better)', () => {
    const candidates = [
      makeEndpointState({ name: 'low', priority: 2 }),
      makeEndpointState({ name: 'high', priority: 0 }),
      makeEndpointState({ name: 'mid', priority: 1 }),
    ];
    const decision = strategy.select(makeContext(), candidates);
    expect(decision!.endpoint.name).toBe('high');
  });

  it('should skip previously tried endpoints on fallback', () => {
    const candidates = [
      makeEndpointState({ name: 'primary', priority: 0 }),
      makeEndpointState({ name: 'secondary', priority: 1 }),
    ];
    const ctx = makeContext(undefined, { attempt: 1, previousEndpoints: ['primary'] });
    const decision = strategy.select(ctx, candidates);
    expect(decision!.endpoint.name).toBe('secondary');
  });
});

describe('LoadBalanceStrategy', () => {
  it('should distribute across endpoints by weight', () => {
    const strategy = new LoadBalanceStrategy();
    const candidates = [
      makeEndpointState({ name: 'a', weight: 2 }),
      makeEndpointState({ name: 'b', weight: 1 }),
    ];
    const ctx = makeContext();

    const selections: string[] = [];
    for (let i = 0; i < 6; i++) {
      const d = strategy.select(ctx, candidates);
      selections.push(d!.endpoint.name);
    }

    // Weight 2:1 means pool = [a, a, b], repeating
    const aCount = selections.filter(s => s === 'a').length;
    const bCount = selections.filter(s => s === 'b').length;
    expect(aCount).toBeGreaterThan(bCount);
  });
});

describe('FallbackStrategy', () => {
  const strategy = new FallbackStrategy();

  it('should return null on first attempt', () => {
    const candidates = [makeEndpointState({ name: 'a' })];
    const decision = strategy.select(makeContext(), candidates);
    expect(decision).toBeNull();
  });

  it('should skip failed endpoints on retry', () => {
    const candidates = [
      makeEndpointState({ name: 'failed', priority: 0 }),
      makeEndpointState({ name: 'next', priority: 1 }),
    ];
    const ctx = makeContext(undefined, { attempt: 1, previousEndpoints: ['failed'] });
    const decision = strategy.select(ctx, candidates);
    expect(decision!.endpoint.name).toBe('next');
  });
});

describe('CustomStrategy', () => {
  it('should delegate to user function', () => {
    const strategy = new CustomStrategy((ctx, candidates) => {
      const tagged = candidates.find(c => c.endpoint.tags?.includes('preferred'));
      return tagged ? { endpoint: tagged.endpoint, reason: 'custom tag match' } : null;
    });

    const candidates = [
      makeEndpointState({ name: 'a' }),
      makeEndpointState({ name: 'b', tags: ['preferred'] }),
    ];
    const decision = strategy.select(makeContext(), candidates);
    expect(decision!.endpoint.name).toBe('b');
    expect(decision!.reason).toBe('custom tag match');
  });
});
