type JsonObject = Record<string, unknown>;

const GEMINI_SCHEMA_KEYS = new Set([
  'additionalProperties',
  'anyOf',
  'enum',
  'items',
  'properties',
  'required',
  'type',
]);

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mapProperties(
  value: unknown,
  transform: (schema: unknown) => unknown,
): JsonObject {
  if (!isJsonObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([name, schema]) => [name, transform(schema)]),
  );
}

function mapStrictProperties(value: unknown): JsonObject {
  if (!isJsonObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, schema]) => !isJsonObject(schema) || !('default' in schema))
      .map(([name, schema]) => [name, projectStrictSchema(schema)]),
  );
}

function projectGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectGeminiSchema);
  if (!isJsonObject(value)) return value;

  const projected: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
    projected[key] =
      key === 'properties'
        ? mapProperties(child, projectGeminiSchema)
        : projectGeminiSchema(child);
  }
  return projected;
}

function projectStrictSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectStrictSchema);
  if (!isJsonObject(value)) return value;

  const projected: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$schema' || key === 'default' || key === 'required') continue;
    projected[key] =
      key === 'properties'
        ? mapStrictProperties(child)
        : projectStrictSchema(child);
  }
  if (isJsonObject(projected.properties)) {
    projected.required = Object.keys(projected.properties);
  }
  return projected;
}

export function toGeminiResponseJsonSchema(schema: JsonObject): JsonObject {
  const projected = projectGeminiSchema(schema);
  if (!isJsonObject(projected)) throw new TypeError('Invalid JSON schema root');
  return projected;
}

export function toStrictResponseJsonSchema(schema: JsonObject): JsonObject {
  const projected = projectStrictSchema(schema);
  if (!isJsonObject(projected)) throw new TypeError('Invalid JSON schema root');
  return projected;
}
