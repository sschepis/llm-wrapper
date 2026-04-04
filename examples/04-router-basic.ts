/**
 * Basic router with priority-based fallback.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... npx tsx examples/04-router-basic.ts
 */
import { LLMRouter } from '@sschepis/llm-wrapper';

async function main() {
  const router = await LLMRouter.create({
    endpoints: [
      {
        name: 'primary',
        provider: 'anthropic',
        model: 'claude-3-5-haiku-20241022',
        config: { apiKey: process.env.ANTHROPIC_API_KEY! },
        priority: 0,
      },
      {
        name: 'fallback',
        provider: 'openai',
        model: 'gpt-4o-mini',
        config: { apiKey: process.env.OPENAI_API_KEY! },
        priority: 1,
      },
    ],
    fallback: true,
    maxFallbackAttempts: 2,
  });

  // Observe routing decisions
  router.events.on('route', ({ decision }) => {
    console.log(`[Router] → ${decision.endpoint.name} (${decision.reason})`);
  });

  router.events.on('fallback', ({ from, to, error }) => {
    console.log(`[Router] Fallback: ${from.name} → ${to.name} (${error.code})`);
  });

  router.events.on('request:complete', ({ endpoint, latencyMs }) => {
    console.log(`[Router] Complete: ${endpoint.name} in ${latencyMs}ms`);
  });

  // Send a request — router picks the best endpoint
  const response = await router.chat({
    model: 'auto', // Router overrides with endpoint's model
    messages: [{ role: 'user', content: 'Hello! What provider are you?' }],
  });

  console.log('\nResponse:', response.choices[0].message.content);
  console.log('Model used:', response.model);
}

main().catch(console.error);
