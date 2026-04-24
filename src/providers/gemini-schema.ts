const UNSUPPORTED_KEYS = new Set([
  'additionalProperties',
  '$schema',
  '$id',
  '$ref',
  'definitions',
  'patternProperties',
]);

const RECURSE_KEYS = ['properties', 'items', 'anyOf', 'oneOf', 'allOf'] as const;

function clean(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(clean);
  }
  if (!node || typeof node !== 'object') {
    return node;
  }

  const input = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (UNSUPPORTED_KEYS.has(key)) continue;

    if ((key === 'exclusiveMinimum' || key === 'exclusiveMaximum') && typeof value === 'boolean') {
      continue;
    }

    if (key === 'properties' && value && typeof value === 'object') {
      const cleanedProps: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        cleanedProps[propName] = clean(propSchema);
      }
      out[key] = cleanedProps;
      continue;
    }

    if (RECURSE_KEYS.includes(key as typeof RECURSE_KEYS[number])) {
      out[key] = clean(value);
      continue;
    }

    out[key] = value;
  }

  return out;
}

export function sanitizeGeminiSchema<T>(schema: T): T {
  if (schema === undefined || schema === null) return schema;
  return clean(schema) as T;
}
