# Router Guide

The `LLMRouter` is an intelligent routing layer that sits between your application and multiple LLM endpoints. It picks the best provider+model combination for each request based on configurable strategies.

## Concepts

### Endpoint

An endpoint is a specific provider + model + configuration combination:

```typescript
interface Endpoint {
  name: string;           // Unique label, e.g. "fast-claude"
  provider: ProviderName; // 'openai', 'anthropic', 'gemini', etc.
  model: string;          // 'gpt-4o', 'claude-sonnet-4-20250514', etc.
  config: ProviderConfig; // API key, base URL, etc.

  // Routing metadata
  priority?: number;         // Lower = preferred (default 0)
  weight?: number;           // For load balancing (default 1)
  costPer1kInput?: number;   // USD per 1k input tokens
  costPer1kOutput?: number;  // USD per 1k output tokens
  capabilities?: {
    streaming?: boolean;
    tools?: boolean;
    vision?: boolean;
    jsonMode?: boolean;
    maxContextWindow?: number;
    maxOutputTokens?: number;
  };
  tags?: string[];           // For custom routing logic
}
```

### Strategy

A strategy is an object that filters and/or selects endpoints:

```typescript
interface RoutingStrategy {
  name: string;
  filter?(ctx: RoutingContext, candidates: EndpointState[]): EndpointState[];
  select(ctx: RoutingContext, candidates: EndpointState[]): RoutingDecision | null;
}
```

Strategies compose into a pipeline:
1. All strategies' `filter()` methods run in sequence (narrowing candidates)
2. Each strategy's `select()` runs in sequence — first non-null result wins
3. If no strategy selects, the first remaining candidate is used

## Built-in Strategies

### CapabilityStrategy (filter-only)

Removes endpoints that can't handle the request:

```typescript
import { CapabilityStrategy } from '@sschepis/llm-wrapper';

// Automatically checks:
// - tools required? → needs capabilities.tools !== false
// - image content?  → needs capabilities.vision !== false
// - json mode?      → needs capabilities.jsonMode !== false
// - streaming?      → needs capabilities.streaming !== false
// - context length? → estimated tokens must fit in context window
```

### CostStrategy

Picks the cheapest endpoint based on estimated cost:

```typescript
import { CostStrategy } from '@sschepis/llm-wrapper';

// Calculates: (inputTokens / 1000) * costPer1kInput + (outputTokens / 1000) * costPer1kOutput
// Requires costPer1kInput and/or costPer1kOutput on endpoints
```

### LatencyStrategy

Picks the endpoint with lowest observed average latency:

```typescript
import { LatencyStrategy } from '@sschepis/llm-wrapper';

// Uses rolling average latency from health tracker
// Only considers endpoints with at least 1 recorded request
```

### PriorityStrategy

Picks by priority number (lower = better). On fallback attempts, skips previously tried endpoints:

```typescript
import { PriorityStrategy } from '@sschepis/llm-wrapper';

// endpoint.priority: 0 = highest priority
// Tie-breaks by weight (higher weight = preferred)
// On fallback: automatically skips failed endpoints
```

### LoadBalanceStrategy

Weighted round-robin distribution:

```typescript
import { LoadBalanceStrategy } from '@sschepis/llm-wrapper';

// Distributes requests proportionally by weight
// weight: 2 gets twice as many requests as weight: 1
```

### FallbackStrategy

Only activates on retry attempts (after a failure). Skips previously failed endpoints and picks by priority:

```typescript
import { FallbackStrategy } from '@sschepis/llm-wrapper';

// Only activates when ctx.attempt > 0
// Returns null on first attempt (lets other strategies decide)
```

### CustomStrategy

Wraps a user-provided function:

```typescript
import { CustomStrategy } from '@sschepis/llm-wrapper';

const byTag = new CustomStrategy((ctx, candidates) => {
  // Route coding tasks to specialized endpoints
  const content = ctx.params.messages.at(-1)?.content;
  if (typeof content === 'string' && content.includes('code')) {
    const coder = candidates.find(c => c.endpoint.tags?.includes('coding'));
    if (coder) return { endpoint: coder.endpoint, reason: 'coding request' };
  }
  return null; // Let next strategy decide
});
```

## Strategy Composition

Combine strategies into a pipeline:

```typescript
const router = await LLMRouter.create({
  endpoints: [...],
  strategy: [
    new CapabilityStrategy(),   // 1. Filter by capabilities
    new CostStrategy(),         // 2. Pick cheapest
  ],
});
```

Common patterns:

```typescript
// Cost-optimized with capability filtering
strategy: [new CapabilityStrategy(), new CostStrategy()]

// Priority-based with fallback
strategy: [new CapabilityStrategy(), new PriorityStrategy()]

// Latency-optimized
strategy: [new CapabilityStrategy(), new LatencyStrategy()]

// Load-balanced with capability filtering
strategy: [new CapabilityStrategy(), new LoadBalanceStrategy()]

// Custom logic with fallback to priority
strategy: [new CapabilityStrategy(), myCustomStrategy, new PriorityStrategy()]
```

## Circuit Breaker

The health tracker implements a circuit breaker per endpoint:

```
CLOSED (healthy)
  ↓ error rate > threshold (after minRequests)
OPEN (broken) — requests skip this endpoint
  ↓ cooldown elapsed
HALF-OPEN — allows one probe request
  ↓ probe succeeds → CLOSED
  ↓ probe fails → OPEN
```

### Configuration

```typescript
healthCheck: {
  enabled: true,          // Enable health tracking (default true)
  windowSize: 60_000,     // Rolling window in ms (default 60s)
  errorThreshold: 0.5,    // Error rate to trip (default 0.5)
  cooldownMs: 30_000,     // Time before half-open (default 30s)
  minRequests: 5,         // Min requests before tripping (default 5)
}
```

### Inspecting Health

```typescript
const health = router.getHealthState();
for (const [name, state] of health) {
  console.log(`${name}: ${state.status} (${state.errorRate * 100}% errors, ${state.avgLatencyMs}ms avg)`);
}

// Reset health for a specific endpoint
router.resetHealth('problematic-endpoint');

// Reset all
router.resetHealth();
```

## Fallback

When a chat request fails:
1. The error is recorded in the health tracker
2. The router re-routes with the failed endpoint excluded
3. Repeats until success or `maxFallbackAttempts` exhausted

```typescript
const router = await LLMRouter.create({
  endpoints: [...],
  fallback: true,              // Enable fallback (default true)
  maxFallbackAttempts: 3,      // Max retries (default 3)
});
```

**Streams do NOT fallback** — partial consumption can't be replayed.

## Events

The router emits typed events for observability:

| Event | When | Data |
|---|---|---|
| `route` | Endpoint selected | `{ decision, context }` |
| `fallback` | Falling back to another endpoint | `{ from, to, error, attempt }` |
| `circuit:open` | Circuit breaker tripped | `{ endpoint, health }` |
| `circuit:close` | Circuit breaker recovered | `{ endpoint }` |
| `circuit:half-open` | Entering probe state | `{ endpoint }` |
| `request:complete` | Request succeeded | `{ endpoint, latencyMs, usage }` |
| `request:error` | Request failed | `{ endpoint, error }` |

```typescript
// Events API
router.events.on('route', handler);
router.events.off('route', handler);
router.events.removeAllListeners('route');
router.events.removeAllListeners(); // all events
```

Alternatively, use hooks in the config:

```typescript
const router = await LLMRouter.create({
  endpoints: [...],
  hooks: {
    onRoute: (decision, ctx) => { ... },
    onFallback: (from, to, error) => { ... },
    onCircuitBreak: (endpoint, health) => { ... },
    onCircuitRecover: (endpoint) => { ... },
    onRequestComplete: (endpoint, latencyMs, usage) => { ... },
  },
});
```

## Dynamic Endpoints

Add and remove endpoints at runtime:

```typescript
await router.addEndpoint({
  name: 'new-endpoint',
  provider: 'openai',
  model: 'gpt-4o-mini',
  config: { apiKey: '...' },
});

router.removeEndpoint('old-endpoint');
```
