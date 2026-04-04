/**
 * Error handling and hooks.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... npx tsx examples/08-error-handling.ts
 */
import { UniversalLLM, LLMError, LLMErrorCode } from '@sschepis/llm-wrapper';

async function main() {
  const client = await UniversalLLM.create({
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
    hooks: {
      onBeforeRequest: (params) => {
        console.log(`[Hook] Sending request: ${params.model}, ${params.messages.length} messages`);
        return params;
      },
      onAfterResponse: (response) => {
        console.log(`[Hook] Response: ${response.usage.total_tokens} tokens, finish=${response.choices[0].finish_reason}`);
      },
      onError: (error) => {
        console.error(`[Hook] Error: ${error.message}`);
      },
    },
  });

  // Successful request
  console.log('--- Successful Request ---');
  const response = await client.chat({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Say hi in one word.' }],
    max_tokens: 10,
  });
  console.log('Content:', response.choices[0].message.content);
  console.log('');

  // Error handling
  console.log('--- Error Handling ---');
  try {
    await client.chat({
      model: 'nonexistent-model-xyz',
      messages: [{ role: 'user', content: 'Hello' }],
    });
  } catch (err) {
    if (err instanceof LLMError) {
      console.log('Error code:', err.code);
      console.log('Provider:', err.provider);
      console.log('HTTP status:', err.statusCode);
      console.log('Retryable:', err.retryable);
      console.log('Message:', err.message);

      switch (err.code) {
        case LLMErrorCode.RATE_LIMIT:
          console.log('→ Rate limited — was retried automatically');
          break;
        case LLMErrorCode.INVALID_API_KEY:
          console.log('→ Check your API key');
          break;
        case LLMErrorCode.MODEL_NOT_FOUND:
          console.log('→ Model does not exist');
          break;
        case LLMErrorCode.CONTEXT_EXCEEDED:
          console.log('→ Message too long — try truncating');
          break;
        case LLMErrorCode.PROVIDER_UNAVAILABLE:
          console.log('→ Provider is down — was retried automatically');
          break;
        default:
          console.log('→ Unexpected error');
      }
    }
  }
}

main().catch(console.error);
