const NON_EMPTY_STRING_SCHEMA = {
  type: 'string',
  minLength: 1,
  pattern: '\\S'
} as const;

export const UNKNOWN_MODEL_PRICE_SENTINEL = -1_000_000;

const MODEL_PRICE_SCHEMA = {
  anyOf: [{ type: 'number', minimum: 0 }, { const: UNKNOWN_MODEL_PRICE_SENTINEL }]
} as const;

const MODEL_PRICE_RATE_PROPERTIES = {
  inputPerMillionUsd: MODEL_PRICE_SCHEMA,
  outputPerMillionUsd: MODEL_PRICE_SCHEMA,
  cacheReadPerMillionUsd: MODEL_PRICE_SCHEMA,
  cacheWritePerMillionUsd: MODEL_PRICE_SCHEMA
} as const;

export const MODEL_PRICE_RATES_SCHEMA = {
  type: 'object',
  required: ['inputPerMillionUsd', 'outputPerMillionUsd'],
  properties: MODEL_PRICE_RATE_PROPERTIES,
  additionalProperties: true
} as const;

export const MODEL_PRICE_RATE_OVERRIDES_SCHEMA = {
  type: 'object',
  properties: MODEL_PRICE_RATE_PROPERTIES,
  additionalProperties: true
} as const;

export const PROMPT_LENGTH_PRICING_TIER_SCHEMA = {
  type: 'object',
  required: ['minimumPromptTokens', 'rates'],
  properties: {
    minimumPromptTokens: { type: 'integer', minimum: 1 },
    rates: MODEL_PRICE_RATE_OVERRIDES_SCHEMA
  },
  additionalProperties: true
} as const;

export const MODEL_PRICE_DESCRIPTOR_SCHEMA = {
  type: 'object',
  required: ['inputPerMillionUsd', 'outputPerMillionUsd'],
  properties: {
    ...MODEL_PRICE_RATE_PROPERTIES,
    serviceTierRates: {
      type: 'object',
      additionalProperties: MODEL_PRICE_RATE_OVERRIDES_SCHEMA
    },
    promptLengthTiers: {
      type: 'array',
      items: PROMPT_LENGTH_PRICING_TIER_SCHEMA
    },
    cacheWritePerMillionUsdByTtl: {
      type: 'object',
      properties: {
        '5m': { type: 'number', minimum: 0 },
        '1h': { type: 'number', minimum: 0 }
      },
      additionalProperties: false
    }
  },
  additionalProperties: true
} as const;

const MODEL_ROLE_SCHEMA = {
  type: 'string',
  enum: ['planning', 'drafting', 'auditing', 'polishing']
} as const;

const MODEL_NETWORK_MODE_SCHEMA = {
  type: 'string',
  enum: ['offline', 'optional', 'required']
} as const;

const OUTPUT_FORMAT_SCHEMA = {
  type: 'string',
  enum: ['text', 'structured', 'patch']
} as const;

const MODEL_CAPABILITY_PROPERTIES = {
  capabilities: { type: 'array', items: { type: 'string' }, readOnly: true },
  network: MODEL_NETWORK_MODE_SCHEMA,
  modalities: { type: 'array', items: { type: 'string' }, readOnly: true },
  outputFormats: { type: 'array', items: OUTPUT_FORMAT_SCHEMA, readOnly: true },
  streaming: { type: 'boolean' },
  contextTokens: { type: 'number', minimum: Number.MIN_VALUE },
  maxOutputTokens: { type: 'number', minimum: Number.MIN_VALUE },
  tools: { type: 'boolean' },
  reasoning: { type: 'boolean' },
  structuredOutput: { type: 'boolean' },
  patchOutput: { type: 'boolean' },
  jsonSchema: { type: 'boolean' },
  promptCaching: { type: 'boolean' }
} as const;

const MODEL_CAPABILITY_REQUIRED_FIELDS = [
  'capabilities',
  'network',
  'modalities',
  'outputFormats',
  'streaming',
  'contextTokens',
  'maxOutputTokens',
  'tools',
  'reasoning',
  'structuredOutput',
  'patchOutput',
  'jsonSchema',
  'promptCaching'
] as const;

export const MODEL_CAPABILITY_DECLARATION_SCHEMA = {
  type: 'object',
  required: MODEL_CAPABILITY_REQUIRED_FIELDS,
  properties: MODEL_CAPABILITY_PROPERTIES,
  additionalProperties: true
} as const;

const MODEL_CAPABILITY_OVERRIDES_SCHEMA = {
  type: 'object',
  properties: MODEL_CAPABILITY_PROPERTIES,
  additionalProperties: true
} as const;

export const MODEL_CATALOG_ENTRY_SCHEMA = {
  type: 'object',
  required: ['id', 'name', 'provider', 'contextWindow', 'maxTokens', 'supportsThinking', 'supportsTools', 'cost'],
  properties: {
    id: { ...NON_EMPTY_STRING_SCHEMA, description: 'Stable catalog identifier.' },
    name: { ...NON_EMPTY_STRING_SCHEMA, description: 'Human-readable model name.' },
    provider: { ...NON_EMPTY_STRING_SCHEMA, description: 'Provider identifier.' },
    contextWindow: { type: 'number', minimum: Number.MIN_VALUE, description: 'Maximum input context tokens.' },
    maxTokens: { type: 'number', minimum: Number.MIN_VALUE, description: 'Maximum output tokens.' },
    supportsThinking: { type: 'boolean', description: 'Whether the model supports reasoning output.' },
    supportsTools: { type: 'boolean', description: 'Whether the model supports tool calls.' },
    supportsVision: { type: 'boolean', description: 'Optional image-input capability.' },
    supportsMidConvoEffort: {
      type: 'boolean',
      description: 'Optional support for per-turn reasoning-effort changes.'
    },
    cost: MODEL_PRICE_DESCRIPTOR_SCHEMA,
    capabilities: MODEL_CAPABILITY_OVERRIDES_SCHEMA,
    description: { type: 'string', description: 'Optional catalog description.' },
    roles: { type: 'array', items: MODEL_ROLE_SCHEMA, description: 'Optional recommended task roles.' },
    priority: { type: 'number', description: 'Optional preference within a role; higher values win.' }
  },
  additionalProperties: true
} as const;

export const MODEL_CATALOG_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'InkPi model catalog data',
  description: 'The offline JSON data shape used by packages/ai/src/models-data.json.',
  type: 'array',
  items: MODEL_CATALOG_ENTRY_SCHEMA
} as const;

type RequiredKeys<Schema, Properties extends Record<string, unknown>> = Schema extends {
  required: readonly (infer Key)[];
}
  ? Extract<Key, keyof Properties>
  : never;

type AdditionalProperties<Schema> = Schema extends { additionalProperties: infer Additional }
  ? Additional extends boolean
    ? Record<never, never>
    : Additional extends Record<string, unknown>
      ? Record<string, InferJsonSchema<Additional>>
      : Record<never, never>
  : Record<never, never>;

type InferObject<Schema, Properties extends Record<string, unknown>> = {
  [Key in RequiredKeys<Schema, Properties>]-?: InferJsonSchema<Properties[Key]>;
} & {
  [Key in Exclude<keyof Properties, RequiredKeys<Schema, Properties>>]?: InferJsonSchema<Properties[Key]>;
} & AdditionalProperties<Schema>;

export type InferJsonSchema<Schema> = Schema extends { const: infer Constant }
  ? Constant
  : Schema extends { enum: readonly (infer Option)[] }
    ? Option
    : Schema extends { anyOf: readonly (infer Alternative)[] }
      ? InferJsonSchema<Alternative>
      : Schema extends { oneOf: readonly (infer Alternative)[] }
        ? InferJsonSchema<Alternative>
        : Schema extends { type: 'string' }
          ? string
          : Schema extends { type: 'number' | 'integer' }
            ? number
            : Schema extends { type: 'boolean' }
              ? boolean
              : Schema extends { type: 'array'; items: infer Item }
                ? Schema extends { readOnly: true }
                  ? readonly InferJsonSchema<Item>[]
                  : InferJsonSchema<Item>[]
                : Schema extends { type: 'object'; properties: infer Properties extends Record<string, unknown> }
                  ? InferObject<Schema, Properties>
                  : Schema extends { type: 'object'; additionalProperties: infer Additional }
                    ? Additional extends boolean
                      ? Record<string, unknown>
                      : Record<string, InferJsonSchema<Additional>>
                    : unknown;

export type ModelRole = InferJsonSchema<typeof MODEL_ROLE_SCHEMA>;
export type ModelNetworkMode = InferJsonSchema<typeof MODEL_NETWORK_MODE_SCHEMA>;
export type ModelPriceRates = InferJsonSchema<typeof MODEL_PRICE_RATES_SCHEMA>;
export type ModelPriceRateOverrides = InferJsonSchema<typeof MODEL_PRICE_RATE_OVERRIDES_SCHEMA>;
export type PromptLengthPricingTier = InferJsonSchema<typeof PROMPT_LENGTH_PRICING_TIER_SCHEMA>;
export type ModelPriceDescriptor = InferJsonSchema<typeof MODEL_PRICE_DESCRIPTOR_SCHEMA>;
export type ModelCapabilityDeclaration = InferJsonSchema<typeof MODEL_CAPABILITY_DECLARATION_SCHEMA>;
export type ModelCapabilityOverrides = InferJsonSchema<typeof MODEL_CAPABILITY_OVERRIDES_SCHEMA>;
export type ModelCatalogEntry = InferJsonSchema<typeof MODEL_CATALOG_ENTRY_SCHEMA>;
export type ModelCatalogData = InferJsonSchema<typeof MODEL_CATALOG_SCHEMA>;
