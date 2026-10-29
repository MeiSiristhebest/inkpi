export const PROJECT_CONFIG_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'InkPi project configuration',
  description: 'Configuration loaded from inkpi.config.json by the InkPi CLI.',
  type: 'object',
  properties: {
    $schema: {
      description:
        'Optional editor metadata. The CLI does not fetch or validate this value; use a relative schema path where possible.'
    },
    name: {
      type: 'string',
      minLength: 1,
      pattern: '\\S',
      description: 'Optional project name. Must contain a non-whitespace character.'
    },
    version: {
      type: 'string',
      minLength: 1,
      pattern: '\\S',
      description: 'Optional project version label. InkPi does not enforce semantic-version syntax.'
    },
    defaultModel: {
      type: 'string',
      minLength: 1,
      pattern: '\\S',
      description: 'Optional default model identifier; runtime availability is resolved separately.'
    },
    plugins: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional plugin identifiers.'
    },
    typography: {
      description: 'Optional typography settings, or false to disable typography formatting.',
      oneOf: [
        { const: false },
        {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['chinese', 'western', 'none'],
              description: 'Optional typography mode.'
            },
            indentString: {
              type: 'string',
              description: 'Optional indentation string used by typography formatting.'
            }
          },
          additionalProperties: true
        }
      ]
    }
  },
  additionalProperties: true
};

const projectProperties = PROJECT_CONFIG_SCHEMA.properties;

export function validateProjectConfig(value) {
  if (!isRecord(value)) return ['the document must be a JSON object'];

  const errors = [];
  for (const [key, schema] of Object.entries(projectProperties)) {
    if (!(key in value)) continue;

    if (schema.type === 'string') {
      const fieldValue = value[key];
      if (
        typeof fieldValue !== 'string' ||
        (schema.minLength === 1 && schema.pattern === '\\S' && fieldValue.trim().length === 0)
      ) {
        errors.push(`${key} must be a non-empty string`);
      }
      continue;
    }

    if (schema.type === 'array') {
      if (!Array.isArray(value[key]) || value[key].some((item) => !matchesSimpleType(item, schema.items.type))) {
        errors.push(`${key} must be an array of strings`);
      }
      continue;
    }

    if (!Array.isArray(schema.oneOf)) continue;
    const literalVariant = schema.oneOf.find((variant) => Object.hasOwn(variant, 'const'));
    if (literalVariant && value[key] === literalVariant.const) continue;

    const objectVariant = schema.oneOf.find((variant) => variant.type === 'object');
    if (!isRecord(value[key]) || !objectVariant) {
      errors.push(`${key} must be false or an object`);
      continue;
    }

    for (const [nestedKey, nestedSchema] of Object.entries(objectVariant.properties ?? {})) {
      if (!(nestedKey in value[key])) continue;
      const nestedValue = value[key][nestedKey];
      if (nestedSchema.enum && (typeof nestedValue !== 'string' || !nestedSchema.enum.includes(nestedValue))) {
        errors.push(`${key}.${nestedKey} must be one of ${nestedSchema.enum.join(', ')}`);
      } else if (nestedSchema.type && !matchesSimpleType(nestedValue, nestedSchema.type)) {
        errors.push(`${key}.${nestedKey} must be a ${nestedSchema.type}`);
      }
    }
  }

  return errors;
}

function matchesSimpleType(value, type) {
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isRecord(value);
  return true;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
