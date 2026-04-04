/**
 * Custom routing strategy that routes based on request content.
 * Coding tasks go to a specialized endpoint, everything else goes to a general one.
 *
 * Usage:
 *   OPENAI_API_KEY=... ANTHROPIC_API_KEY=... npx tsx examples/06-router-custom-strategy.ts
 */
import {
  LLMRouter,
  CapabilityStrategy,
  CustomStrategy,
  PriorityStrategy,
} from '@sschepis/llm-wrapper';
import type { RoutingContext, EndpointState, RoutingDecision } from '@sschepis/llm-wrapper';

// Custom strategy: route coding tasks to a coding-specialized endpoint
function codingRouter(ctx: RoutingContext, candidates: EndpointState[]): RoutingDecision | null {
  const lastMessage = ctx.params.messages.at(-1);
  const content = typeof lastMessage?.content === 'string' ? lastMessage.content : '';

  const codingKeywords = ['code', 'function', 'bug', 'error', 'implement', 'refactor', 'typescript', 'python'];
  const isCodingTask = codingKeywords.some(kw => content.toLowerCase().includes(kw));

  if (isCodingTask) {
    const coder = candidates.find(c => c.endpoint.tags?.includes('coding'));
    if (coder) {
      return { endpoint: coder.endpoint, reason: 'coding task detected' };
    }
  }

  return null; // Let next strategy decide
}

async function main() {
  const router = await LLMRouter.create({
    endpoints: [
      {
        name: 'claude-coder',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        config: { apiKey: process.env.ANTHROPIC_API_KEY! },
        tags: ['coding'],
        priority: 1,
      },
      {
        name: 'gpt-general',
        provider: 'openai',
        model: 'gpt-4o-mini',
        config: { apiKey: process.env.OPENAI_API_KEY! },
        tags: ['general'],
        priority: 0,
      },
    ],
    strategy: [
      new CapabilityStrategy(),
      new CustomStrategy(codingRouter),
      new PriorityStrategy(), // Fallback if custom doesn't match
    ],
  });

  router.events.on('route', ({ decision }) => {
    console.log(`→ ${decision.endpoint.name}: ${decision.reason}\n`);
  });

  // General question → gpt-general (via PriorityStrategy)
  console.log('Q: "What is the capital of France?"');
  const r1 = await router.chat({
    model: 'auto',
    messages: [{ role: 'user', content: 'What is the capital of France?' }],
  });
  console.log(`A: ${r1.choices[0].message.content}\n`);

  // Coding question → claude-coder (via CustomStrategy)
  console.log('Q: "Write a TypeScript function to reverse a string"');
  const r2 = await router.chat({
    model: 'auto',
    messages: [{ role: 'user', content: 'Write a TypeScript function to reverse a string' }],
  });
  console.log(`A: ${r2.choices[0].message.content}\n`);
}

main().catch(console.error);
