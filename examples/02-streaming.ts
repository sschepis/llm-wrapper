/**
 * Streaming chat completion with stream aggregation.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/02-streaming.ts
 */
import { UniversalLLM, aggregateStream, teeStream } from '@sschepis/llm-wrapper';

async function basicStreaming() {
  const client = await UniversalLLM.create({
    provider: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
  });

  console.log('--- Basic Streaming ---');

  for await (const chunk of client.stream({
    model: 'claude-3-5-haiku-20241022',
    messages: [{ role: 'user', content: 'Count from 1 to 5, one per line.' }],
    max_tokens: 100,
  })) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) process.stdout.write(content);
  }
  console.log('\n');
}

async function streamWithAggregation() {
  const client = await UniversalLLM.create({
    provider: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
  });

  console.log('--- Stream + Aggregate ---');

  // teeStream lets you consume chunks AND get the final response
  const { chunks, result } = teeStream(client.stream({
    model: 'claude-3-5-haiku-20241022',
    messages: [{ role: 'user', content: 'Say hello in 3 languages.' }],
    max_tokens: 200,
  }));

  for await (const chunk of chunks) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) process.stdout.write(content);
  }

  const response = await result;
  console.log(`\n\nTotal tokens: ${response.usage.total_tokens}`);
}

async function main() {
  await basicStreaming();
  await streamWithAggregation();
}

main().catch(console.error);
