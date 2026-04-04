import type { HealthState, HealthCheckConfig, CircuitState } from './types.js';
import type { LLMError } from '../core/errors.js';
import { RouterEventEmitter } from './events.js';
import type { Endpoint } from './types.js';

interface TimeBucket {
  timestamp: number;
  requests: number;
  errors: number;
  totalLatencyMs: number;
}

interface MutableState {
  status: CircuitState;
  consecutiveFailures: number;
  totalRequests: number;
  totalErrors: number;
  lastErrorTime?: number;
  lastSuccessTime?: number;
  openedAt?: number;
  buckets: TimeBucket[];
}

const BUCKET_COUNT = 6;

export class HealthTracker {
  private states = new Map<string, MutableState>();
  private config: Required<HealthCheckConfig>;
  private endpoints = new Map<string, Endpoint>();
  private events?: RouterEventEmitter;

  constructor(config?: HealthCheckConfig, events?: RouterEventEmitter) {
    this.config = {
      enabled: config?.enabled ?? true,
      windowSize: config?.windowSize ?? 60_000,
      errorThreshold: config?.errorThreshold ?? 0.5,
      cooldownMs: config?.cooldownMs ?? 30_000,
      minRequests: config?.minRequests ?? 5,
    };
    this.events = events;
  }

  registerEndpoint(endpoint: Endpoint): void {
    this.endpoints.set(endpoint.name, endpoint);
    if (!this.states.has(endpoint.name)) {
      this.states.set(endpoint.name, this.newState());
    }
  }

  getState(name: string): HealthState {
    const state = this.states.get(name);
    if (!state) {
      return {
        status: 'closed',
        errorRate: 0,
        avgLatencyMs: 0,
        consecutiveFailures: 0,
        totalRequests: 0,
        totalErrors: 0,
      };
    }

    // Check for half-open transition
    if (state.status === 'open' && state.openedAt) {
      if (Date.now() - state.openedAt >= this.config.cooldownMs) {
        state.status = 'half-open';
        const endpoint = this.endpoints.get(name);
        if (endpoint) {
          this.events?.emit('circuit:half-open', { endpoint });
        }
      }
    }

    const { errorRate, avgLatencyMs } = this.computeWindowStats(state);

    return {
      status: state.status,
      errorRate,
      avgLatencyMs,
      lastErrorTime: state.lastErrorTime,
      lastSuccessTime: state.lastSuccessTime,
      consecutiveFailures: state.consecutiveFailures,
      totalRequests: state.totalRequests,
      totalErrors: state.totalErrors,
    };
  }

  recordSuccess(name: string, latencyMs: number): void {
    if (!this.config.enabled) return;
    const state = this.getOrCreateState(name);
    const now = Date.now();

    state.totalRequests++;
    state.consecutiveFailures = 0;
    state.lastSuccessTime = now;
    this.addToBucket(state, now, false, latencyMs);

    // Half-open probe succeeded → close circuit
    if (state.status === 'half-open' || state.status === 'open') {
      state.status = 'closed';
      state.openedAt = undefined;
      const endpoint = this.endpoints.get(name);
      if (endpoint) {
        this.events?.emit('circuit:close', { endpoint });
      }
    }
  }

  recordFailure(name: string, _error: LLMError): void {
    if (!this.config.enabled) return;
    const state = this.getOrCreateState(name);
    const now = Date.now();

    state.totalRequests++;
    state.totalErrors++;
    state.consecutiveFailures++;
    state.lastErrorTime = now;
    this.addToBucket(state, now, true, 0);

    // Check if circuit should trip
    if (state.status === 'closed') {
      const { errorRate, windowRequests } = this.computeWindowStats(state);
      if (windowRequests >= this.config.minRequests && errorRate >= this.config.errorThreshold) {
        state.status = 'open';
        state.openedAt = now;
        const endpoint = this.endpoints.get(name);
        if (endpoint) {
          this.events?.emit('circuit:open', {
            endpoint,
            health: this.getState(name),
          });
        }
      }
    } else if (state.status === 'half-open') {
      // Half-open probe failed → re-open
      state.status = 'open';
      state.openedAt = now;
    }
  }

  isAvailable(name: string): boolean {
    if (!this.config.enabled) return true;
    const health = this.getState(name);
    return health.status !== 'open';
  }

  reset(name?: string): void {
    if (name) {
      this.states.set(name, this.newState());
    } else {
      for (const key of this.states.keys()) {
        this.states.set(key, this.newState());
      }
    }
  }

  // --- Private ---

  private newState(): MutableState {
    return {
      status: 'closed',
      consecutiveFailures: 0,
      totalRequests: 0,
      totalErrors: 0,
      buckets: [],
    };
  }

  private getOrCreateState(name: string): MutableState {
    let state = this.states.get(name);
    if (!state) {
      state = this.newState();
      this.states.set(name, state);
    }
    return state;
  }

  private addToBucket(state: MutableState, now: number, isError: boolean, latencyMs: number): void {
    const bucketSize = this.config.windowSize / BUCKET_COUNT;
    const bucketTimestamp = Math.floor(now / bucketSize) * bucketSize;

    let bucket = state.buckets.find(b => b.timestamp === bucketTimestamp);
    if (!bucket) {
      bucket = { timestamp: bucketTimestamp, requests: 0, errors: 0, totalLatencyMs: 0 };
      state.buckets.push(bucket);
    }

    bucket.requests++;
    if (isError) bucket.errors++;
    bucket.totalLatencyMs += latencyMs;

    // Expire old buckets
    const cutoff = now - this.config.windowSize;
    state.buckets = state.buckets.filter(b => b.timestamp >= cutoff);
  }

  private computeWindowStats(state: MutableState): {
    errorRate: number;
    avgLatencyMs: number;
    windowRequests: number;
  } {
    const now = Date.now();
    const cutoff = now - this.config.windowSize;
    const activeBuckets = state.buckets.filter(b => b.timestamp >= cutoff);

    let totalRequests = 0;
    let totalErrors = 0;
    let totalLatency = 0;

    for (const b of activeBuckets) {
      totalRequests += b.requests;
      totalErrors += b.errors;
      totalLatency += b.totalLatencyMs;
    }

    const successfulRequests = totalRequests - totalErrors;

    return {
      errorRate: totalRequests > 0 ? totalErrors / totalRequests : 0,
      avgLatencyMs: successfulRequests > 0 ? totalLatency / successfulRequests : 0,
      windowRequests: totalRequests,
    };
  }
}
