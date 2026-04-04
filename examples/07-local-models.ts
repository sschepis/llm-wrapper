/**
 * Using local model providers (Ollama, LM Studio).
 *
 * Prerequisites:
 *   - Ollama: Install from https://ollama.ai, run `ollama pull llama3.2`
 *   - LM Studio: Install from https://lmstudio.ai, load a model, start server
 *
 * Usage:
 *   npx tsx examples/07-local-models.ts
 */
import { OllamaProvider, createCompatProvider } from '@sschepis/llm-wrapper';

async function ollamaExample() {
  console.log('--- Ollama ---');

  const ollama = new OllamaProvider({
    // baseUrl: 'http://localhost:11434/v1', // default
  });

  // Check if Ollama is running
  const isUp = await ollama.healthCheck();
  if (!isUp) {
    console.log('Ollama is not running. Start it with: ollama serve');
    return;
  }

  // List available models
  const models = await ollama.listModels();
  console.log('Available models:', models.join(', '));

  if (models.length === 0) {
    console.log('No models found. Pull one with: ollama pull llama3.2');
    return;
  }

  // Chat with the first available model
  const response = await ollama.chat({
    model: models[0],
    messages: [{ role: 'user', content: 'Hello! What model are you?' }],
  });

  console.log(`Response (${response.model}):`, response.choices[0].message.content);
  console.log('');
}

async function lmStudioExample() {
  console.log('--- LM Studio ---');

  const lmstudio = createCompatProvider('lmstudio', {});

  try {
    const response = await lmstudio.chat({
      model: 'local-model', // LM Studio uses whatever model is loaded
      messages: [{ role: 'user', content: 'Hello! What model are you?' }],
    });

    console.log(`Response:`, response.choices[0].message.content);
  } catch (err) {
    console.log('LM Studio is not running. Start the server in LM Studio settings.');
  }
}

async function main() {
  await ollamaExample();
  await lmStudioExample();
}

main().catch(console.error);
