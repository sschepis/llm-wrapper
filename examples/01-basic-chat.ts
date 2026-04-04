/**
 * Basic chat completion with different providers.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... npx tsx examples/01-basic-chat.ts
 */
import { UniversalLLM } from '@sschepis/llm-wrapper';

async function main() {
  // Create a client — swap 'openai' for 'anthropic', 'gemini', etc.
  const client = await UniversalLLM.create({
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
  });

  const response = await client.chat({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are a helpful assistant. Be concise.' },
      { role: 'user', content: 'What is TypeScript in one sentence?' },
    ],
    temperature: 0.7,
    max_tokens: 100,
  });

  console.log('Response:', response.choices[0].message.content);
  console.log('Tokens used:', response.usage.total_tokens);
  console.log('Finish reason:', response.choices[0].finish_reason);
}

main().catch(console.error);
