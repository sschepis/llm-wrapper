/**
 * Cost-optimized routing with capability filtering.
 * The router automatically picks the cheapest endpoint that can handle the request.
 *
 * Usage:
 *   OPENAI_API_KEY=... ANTHROPIC_API_KEY=... GEMINI_API_KEY=... npx tsx examples/05-router-cost-optimized.ts
 */
import {
  LLMRouter,
  CapabilityStrategy,
  CostStrategy,
} from '@sschepis/llm-wrapper';

async function main() {
  const router = await LLMRouter.create({
    endpoints: [
      {
        name: 'claude-sonnet',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        config: { apiKey: process.env.ANTHROPIC_API_KEY! },
        costPer1kInput: 0.003,
        costPer1kOutput: 0.015,
        capabilities: { vision: true, tools: true, jsonMode: true },
      },
      {
        name: 'gpt-4o-mini',
        provider: 'openai',
        model: 'gpt-4o-mini',
        config: { apiKey: process.env.OPENAI_API_KEY! },
        costPer1kInput: 0.00015,
        costPer1kOutput: 0.0006,
        capabilities: { vision: true, tools: true, jsonMode: true },
      },
      {
        name: 'gemini-flash',
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        config: { apiKey: process.env.GEMINI_API_KEY! },
        costPer1kInput: 0.0001,
        costPer1kOutput: 0.0004,
        capabilities: { vision: true, tools: true, jsonMode: false },
      },
    ],
    strategy: [new CapabilityStrategy(), new CostStrategy()],
  });

  router.events.on('route', ({ decision }) => {
    console.log(`Routed to: ${decision.endpoint.name} — ${decision.reason}`);
  });

  // Simple text request → cheapest endpoint (Gemini Flash)
  console.log('--- Simple text request ---');
  const r1 = await router.chat({
    model: 'auto',
    messages: [{ role: 'user', content: 'Hello!' }],
  });
  console.log(`Response from ${r1.model}: ${r1.choices[0].message.content}\n`);

  // JSON mode request → Gemini filtered out (jsonMode: false), cheapest of remaining
  console.log('--- JSON mode request ---');
  const r2 = await router.chat({
    model: 'auto',
    messages: [{ role: 'user', content: 'List 3 colors as JSON' }],
    response_format: { type: 'json_object' },
  });
  console.log(`Response from ${r2.model}: ${r2.choices[0].message.content}\n`);
}

main().catch(console.error);
