/**
 * Tool use (function calling) across providers.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... npx tsx examples/03-tool-use.ts
 */
import { UniversalLLM } from '@sschepis/llm-wrapper';
import type { ToolDefinition, Message } from '@sschepis/llm-wrapper';

// Define tools
const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a city',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name' },
          unit: { type: 'string', enum: ['celsius', 'fahrenheit'], description: 'Temperature unit' },
        },
        required: ['city'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Search the web for information',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
    },
  },
];

// Simulate tool execution
function executeTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'get_weather':
      return JSON.stringify({ temp: 72, unit: 'fahrenheit', condition: 'sunny', city: args.city });
    case 'search_web':
      return JSON.stringify({ results: [`Result for: ${args.query}`] });
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

async function main() {
  const client = await UniversalLLM.create({
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
  });

  const messages: Message[] = [
    { role: 'user', content: 'What is the weather like in San Francisco and Tokyo?' },
  ];

  console.log('User:', messages[0].content);
  console.log('');

  // First request — model will call tools
  let response = await client.chat({
    model: 'gpt-4o-mini',
    messages,
    tools,
  });

  // Tool call loop
  while (response.choices[0].finish_reason === 'tool_calls') {
    const assistantMessage = response.choices[0].message;
    messages.push(assistantMessage);

    console.log('Tool calls:');
    for (const tc of assistantMessage.tool_calls!) {
      const args = JSON.parse(tc.function.arguments);
      console.log(`  ${tc.function.name}(${JSON.stringify(args)})`);

      const result = executeTool(tc.function.name, args);
      console.log(`  → ${result}`);

      // Add tool result
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result,
      });
    }

    console.log('');

    // Follow-up request with tool results
    response = await client.chat({
      model: 'gpt-4o-mini',
      messages,
      tools,
    });
  }

  console.log('Assistant:', response.choices[0].message.content);
  console.log(`\nTokens: ${response.usage.total_tokens}`);
}

main().catch(console.error);
