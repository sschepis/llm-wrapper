import { z } from 'zod';

// --- Content Parts (multimodal) ---

export const TextContentPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const ImageContentPartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string(),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }),
});

export const ContentPartSchema = z.discriminatedUnion('type', [
  TextContentPartSchema,
  ImageContentPartSchema,
]);

export type TextContentPart = z.infer<typeof TextContentPartSchema>;
export type ImageContentPart = z.infer<typeof ImageContentPartSchema>;
export type ContentPart = z.infer<typeof ContentPartSchema>;

// --- Tool Call ---

export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string(), // JSON string, matching OpenAI
  }),
});

export type ToolCall = z.infer<typeof ToolCallSchema>;

// --- Roles & Messages ---

export const RoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type Role = z.infer<typeof RoleSchema>;

export const MessageSchema = z.object({
  role: RoleSchema,
  content: z.union([z.string(), z.array(ContentPartSchema), z.null()]),
  name: z.string().optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
});

export type Message = z.infer<typeof MessageSchema>;

// --- Tool Definitions ---

export const ToolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string(),
    parameters: z.record(z.unknown()),
    strict: z.boolean().optional(),
  }),
});

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

// --- Request ---

export const ToolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({ name: z.string() }),
  }),
]);

export type ToolChoice = z.infer<typeof ToolChoiceSchema>;

export const ResponseFormatSchema = z.object({
  type: z.enum(['text', 'json_object']),
});

export const StandardChatParamsSchema = z.object({
  model: z.string(),
  messages: z.array(MessageSchema).min(1),
  tools: z.array(ToolDefinitionSchema).optional(),
  tool_choice: ToolChoiceSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  stream: z.boolean().optional(),
  response_format: ResponseFormatSchema.optional(),
}).passthrough(); // Allow provider-specific passthrough params

export type StandardChatParams = z.infer<typeof StandardChatParamsSchema>;

// --- Response ---

export const UsageSchema = z.object({
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  total_tokens: z.number(),
});

export type Usage = z.infer<typeof UsageSchema>;

export const FinishReasonSchema = z.enum(['stop', 'tool_calls', 'length', 'content_filter']).nullable();
export type FinishReason = z.infer<typeof FinishReasonSchema>;

export const ChoiceSchema = z.object({
  index: z.number(),
  message: MessageSchema,
  finish_reason: FinishReasonSchema,
});

export type Choice = z.infer<typeof ChoiceSchema>;

export const StandardChatResponseSchema = z.object({
  id: z.string(),
  object: z.literal('chat.completion'),
  created: z.number(),
  model: z.string(),
  choices: z.array(ChoiceSchema),
  usage: UsageSchema,
});

export type StandardChatResponse = z.infer<typeof StandardChatResponseSchema>;

// --- Streaming ---

export const DeltaSchema = z.object({
  role: RoleSchema.optional(),
  content: z.union([z.string(), z.null()]).optional(),
  tool_calls: z.array(z.object({
    index: z.number(),
    id: z.string().optional(),
    type: z.literal('function').optional(),
    function: z.object({
      name: z.string().optional(),
      arguments: z.string().optional(),
    }).optional(),
  })).optional(),
});

export type Delta = z.infer<typeof DeltaSchema>;

export const ChunkChoiceSchema = z.object({
  index: z.number(),
  delta: DeltaSchema,
  finish_reason: FinishReasonSchema,
});

export type ChunkChoice = z.infer<typeof ChunkChoiceSchema>;

export const StandardChatChunkSchema = z.object({
  id: z.string(),
  object: z.literal('chat.completion.chunk'),
  created: z.number(),
  model: z.string(),
  choices: z.array(ChunkChoiceSchema),
  usage: UsageSchema.optional().nullable(),
});

export type StandardChatChunk = z.infer<typeof StandardChatChunkSchema>;

// --- Provider Configuration ---

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  maxRetries?: number;
  timeout?: number;
  defaultModel?: string;
  headers?: Record<string, string>;
  hooks?: {
    onBeforeRequest?: (params: StandardChatParams) => StandardChatParams | Promise<StandardChatParams>;
    onAfterResponse?: (response: StandardChatResponse) => void | Promise<void>;
    onError?: (error: Error) => void;
  };
}

// --- Model Info ---

export interface ModelInfo {
  contextWindow: number;
  maxOutputTokens: number;
  provider: string;
}
