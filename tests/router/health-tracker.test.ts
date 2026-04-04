import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HealthTracker } from '../../src/router/health-tracker.js';
import { LLMError, LLMErrorCode } from '../../src/core/errors.js';
import { RouterEventEmitter } from '../../src/router/events.js';
import type { Endpoint } from '../../src/router/types.js';

function makeEndpoint(name: string): Endpoint {
  return { name, provider: 'openai', model: 'gpt-4o', config: { apiKey: 'test' } };
}

function makeError(msg = 'fail'): LLMError {
  return new LLMError(msg, LLMErrorCode.PROVIDER_UNAVAILABLE, 'test', 500, true);
}

describe('HealthTracker', () => {
  let tracker: HealthTracker;
  let events: RouterEventEmitter;

  beforeEach(() => {
    events = new RouterEventEmitter();
    tracker = new HealthTracker(
      { windowSize: 60_000, errorThreshold: 0.5, cooldownMs: 5_000, minRequests: 3 },
      events,
    );
    tracker.registerEndpoint(makeEndpoint('ep1'));
  });

  it('should start healthy', () => {
    const state = tracker.getState('ep1');
    expect(state.status).toBe('closed');
    expect(state.errorRate).toBe(0);
    expect(state.consecutiveFailures).toBe(0);
    expect(tracker.isAvailable('ep1')).toBe(true);
  });

  it('should track successes', () => {
    tracker.recordSuccess('ep1', 100);
    tracker.recordSuccess('ep1', 200);
    const state = tracker.getState('ep1');
    expect(state.totalRequests).toBe(2);
    expect(state.avgLatencyMs).toBeGreaterThan(0);
    expect(state.consecutiveFailures).toBe(0);
  });

  it('should track failures and compute error rate', () => {
    tracker.recordSuccess('ep1', 100);
    tracker.recordFailure('ep1', makeError());
    tracker.recordFailure('ep1', makeError());
    const state = tracker.getState('ep1');
    expect(state.totalErrors).toBe(2);
    expect(state.consecutiveFailures).toBe(2);
    expect(state.errorRate).toBeCloseTo(2 / 3);
  });

  it('should trip circuit breaker when threshold exceeded', () => {
    const handler = vi.fn();
    events.on('circuit:open', handler);

    // Need minRequests=3, errorThreshold=0.5
    tracker.recordFailure('ep1', makeError());
    tracker.recordFailure('ep1', makeError());
    expect(tracker.isAvailable('ep1')).toBe(true); // Only 2 requests, below minRequests

    tracker.recordFailure('ep1', makeError()); // 3rd request, error rate = 1.0 > 0.5
    expect(tracker.isAvailable('ep1')).toBe(false);
    expect(tracker.getState('ep1').status).toBe('open');
    expect(handler).toHaveBeenCalled();
  });

  it('should not trip if error rate is below threshold', () => {
    tracker.recordSuccess('ep1', 100);
    tracker.recordSuccess('ep1', 100);
    tracker.recordSuccess('ep1', 100);
    tracker.recordFailure('ep1', makeError()); // 1/4 = 0.25 < 0.5
    expect(tracker.isAvailable('ep1')).toBe(true);
  });

  it('should transition open → half-open after cooldown', () => {
    // Trip the circuit
    tracker.recordFailure('ep1', makeError());
    tracker.recordFailure('ep1', makeError());
    tracker.recordFailure('ep1', makeError());
    expect(tracker.getState('ep1').status).toBe('open');

    // Simulate time passing
    const state = (tracker as any).states.get('ep1');
    state.openedAt = Date.now() - 6_000; // Past cooldown (5000ms)

    const halfOpenHandler = vi.fn();
    events.on('circuit:half-open', halfOpenHandler);

    expect(tracker.getState('ep1').status).toBe('half-open');
    expect(tracker.isAvailable('ep1')).toBe(true); // half-open allows probes
    expect(halfOpenHandler).toHaveBeenCalled();
  });

  it('should close circuit on success after half-open', () => {
    // Trip and move to half-open
    tracker.recordFailure('ep1', makeError());
    tracker.recordFailure('ep1', makeError());
    tracker.recordFailure('ep1', makeError());
    const state = (tracker as any).states.get('ep1');
    state.openedAt = Date.now() - 6_000;
    tracker.getState('ep1'); // trigger half-open transition

    const closeHandler = vi.fn();
    events.on('circuit:close', closeHandler);

    tracker.recordSuccess('ep1', 100);
    expect(tracker.getState('ep1').status).toBe('closed');
    expect(closeHandler).toHaveBeenCalled();
  });

  it('should re-open circuit on failure in half-open', () => {
    tracker.recordFailure('ep1', makeError());
    tracker.recordFailure('ep1', makeError());
    tracker.recordFailure('ep1', makeError());
    const state = (tracker as any).states.get('ep1');
    state.openedAt = Date.now() - 6_000;
    state.status = 'half-open';

    tracker.recordFailure('ep1', makeError());
    expect(tracker.getState('ep1').status).toBe('open');
  });

  it('should reset state', () => {
    tracker.recordFailure('ep1', makeError());
    tracker.recordFailure('ep1', makeError());
    tracker.recordFailure('ep1', makeError());
    expect(tracker.getState('ep1').status).toBe('open');

    tracker.reset('ep1');
    expect(tracker.getState('ep1').status).toBe('closed');
    expect(tracker.getState('ep1').totalRequests).toBe(0);
  });
});
