export enum LLMErrorCode {
  RATE_LIMIT = 'LLM_RATE_LIMIT_REACHED',
  CONTEXT_EXCEEDED = 'LLM_CONTEXT_EXCEEDED',
  INVALID_API_KEY = 'LLM_INVALID_API_KEY',
  PROVIDER_UNAVAILABLE = 'LLM_PROVIDER_UNAVAILABLE',
  INVALID_REQUEST = 'LLM_INVALID_REQUEST',
  CONTENT_FILTER = 'LLM_CONTENT_FILTER',
  MODEL_NOT_FOUND = 'LLM_MODEL_NOT_FOUND',
  UNKNOWN = 'LLM_UNKNOWN_ERROR',
}

export class LLMError extends Error {
  public readonly code: LLMErrorCode;
  public readonly provider: string;
  public readonly statusCode: number | undefined;
  public readonly retryable: boolean;

  constructor(
    message: string,
    code: LLMErrorCode,
    provider: string,
    statusCode?: number,
    retryable: boolean = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LLMError';
    this.code = code;
    this.provider = provider;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}
