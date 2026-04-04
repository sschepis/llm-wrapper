import type { Endpoint, HealthState, RoutingContext, RoutingDecision } from './types.js';
import type { LLMError } from '../core/errors.js';
import type { Usage } from '../core/types.js';

export type RouterEventMap = {
  'route': { decision: RoutingDecision; context: RoutingContext };
  'fallback': { from: Endpoint; to: Endpoint; error: LLMError; attempt: number };
  'circuit:open': { endpoint: Endpoint; health: HealthState };
  'circuit:close': { endpoint: Endpoint };
  'circuit:half-open': { endpoint: Endpoint };
  'request:complete': { endpoint: Endpoint; latencyMs: number; usage?: Usage };
  'request:error': { endpoint: Endpoint; error: LLMError };
};

type Handler<T> = (data: T) => void;

export class RouterEventEmitter {
  private handlers = new Map<string, Set<Handler<any>>>();

  on<K extends keyof RouterEventMap>(event: K, handler: Handler<RouterEventMap[K]>): this {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
    return this;
  }

  off<K extends keyof RouterEventMap>(event: K, handler: Handler<RouterEventMap[K]>): this {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  emit<K extends keyof RouterEventMap>(event: K, data: RouterEventMap[K]): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch {
          // Don't let event handler errors break the router
        }
      }
    }
  }

  removeAllListeners(event?: keyof RouterEventMap): this {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
    return this;
  }
}
