/**
 * Zero-dependency TypeBox schema builder & runtime validator (1:1 aligned with TypeBox API)
 */

export const TypeBoxKind = Symbol('TypeBoxKind');

export type TSchema = {
  [TypeBoxKind]: string;
  type?: string;
  optional?: boolean;
  nullable?: boolean;
  [key: string]: any;
};

export type Static<T extends TSchema> = T extends { static: infer U } ? U : any;

export const Type = {
  String: (options: { minLength?: number; maxLength?: number; pattern?: string; default?: string } = {}): TSchema & { static: string } => ({
    [TypeBoxKind]: 'String',
    type: 'string',
    ...options
  } as any),

  Number: (options: { minimum?: number; maximum?: number; default?: number } = {}): TSchema & { static: number } => ({
    [TypeBoxKind]: 'Number',
    type: 'number',
    ...options
  } as any),

  Integer: (options: { minimum?: number; maximum?: number; default?: number } = {}): TSchema & { static: number } => ({
    [TypeBoxKind]: 'Integer',
    type: 'integer',
    ...options
  } as any),

  Boolean: (options: { default?: boolean } = {}): TSchema & { static: boolean } => ({
    [TypeBoxKind]: 'Boolean',
    type: 'boolean',
    ...options
  } as any),

  Null: (): TSchema & { static: null } => ({
    [TypeBoxKind]: 'Null',
    type: 'null'
  } as any),

  Literal: <T extends string | number | boolean>(value: T): TSchema & { static: T } => ({
    [TypeBoxKind]: 'Literal',
    const: value,
    value
  } as any),

  Union: <T extends TSchema[]>(schemas: T): TSchema & { static: Static<T[number]> } => ({
    [TypeBoxKind]: 'Union',
    anyOf: schemas,
    schemas
  } as any),

  Object: <T extends Record<string, TSchema>>(properties: T, options: { additionalProperties?: boolean } = {}): TSchema & { static: { [K in keyof T]: Static<T[K]> } } => ({
    [TypeBoxKind]: 'Object',
    type: 'object',
    properties,
    additionalProperties: options.additionalProperties ?? true
  } as any),

  Array: <T extends TSchema>(schema: T, options: { minItems?: number; maxItems?: number } = {}): TSchema & { static: Static<T>[] } => ({
    [TypeBoxKind]: 'Array',
    type: 'array',
    items: schema,
    ...options
  } as any),

  Optional: <T extends TSchema>(schema: T): TSchema & { static?: Static<T> } => ({
    ...schema,
    optional: true
  } as any),

  Record: <K extends TSchema, V extends TSchema>(keySchema: K, valueSchema: V): TSchema & { static: Record<string, Static<V>> } => ({
    [TypeBoxKind]: 'Record',
    type: 'object',
    additionalProperties: valueSchema
  } as any),

  Unknown: (): TSchema & { static: unknown } => ({
    [TypeBoxKind]: 'Unknown'
  } as any),

  Any: (): TSchema & { static: any } => ({
    [TypeBoxKind]: 'Any'
  } as any),

  Unsafe: <T = any>(schema: any): TSchema & { static: T } => ({
    [TypeBoxKind]: 'Unsafe',
    schema
  } as any),

  Ref: (name: string): TSchema => ({
    [TypeBoxKind]: 'Ref',
    $ref: name
  } as any),

  Cyclic: (definitions: Record<string, TSchema>, root: string): TSchema => ({
    [TypeBoxKind]: 'Cyclic',
    definitions,
    root
  } as any)
};

export interface ValidationError {
  path: string;
  message: string;
  value: any;
}

export const Value = {
  Check(schema: TSchema, value: any): boolean {
    return Value.Errors(schema, value).length === 0;
  },

  Errors(schema: TSchema, value: any, path = ''): ValidationError[] {
    const errors: ValidationError[] = [];
    if (!schema) return errors;

    const kind = schema[TypeBoxKind];

    if (value === undefined) {
      if (schema.optional) return errors;
      errors.push({ path: path || '/', message: 'Expected value, got undefined', value });
      return errors;
    }

    if (value === null) {
      if (kind === 'Null') return errors;
      if (schema.nullable) return errors;
      errors.push({ path: path || '/', message: 'Expected non-null value', value });
      return errors;
    }

    switch (kind) {
      case 'String': {
        if (typeof value !== 'string') {
          errors.push({ path: path || '/', message: `Expected string, got ${typeof value}`, value });
        } else {
          if (schema.minLength !== undefined && value.length < schema.minLength) {
            errors.push({ path: path || '/', message: `String length must be >= ${schema.minLength}`, value });
          }
          if (schema.maxLength !== undefined && value.length > schema.maxLength) {
            errors.push({ path: path || '/', message: `String length must be <= ${schema.maxLength}`, value });
          }
        }
        break;
      }
      case 'Number': {
        if (typeof value !== 'number' || Number.isNaN(value)) {
          errors.push({ path: path || '/', message: `Expected number, got ${typeof value}`, value });
        } else {
          if (schema.minimum !== undefined && value < schema.minimum) {
            errors.push({ path: path || '/', message: `Number must be >= ${schema.minimum}`, value });
          }
          if (schema.maximum !== undefined && value > schema.maximum) {
            errors.push({ path: path || '/', message: `Number must be <= ${schema.maximum}`, value });
          }
        }
        break;
      }
      case 'Integer': {
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          errors.push({ path: path || '/', message: `Expected integer, got ${value}`, value });
        } else {
          if (schema.minimum !== undefined && value < schema.minimum) {
            errors.push({ path: path || '/', message: `Integer must be >= ${schema.minimum}`, value });
          }
          if (schema.maximum !== undefined && value > schema.maximum) {
            errors.push({ path: path || '/', message: `Integer must be <= ${schema.maximum}`, value });
          }
        }
        break;
      }
      case 'Boolean': {
        if (typeof value !== 'boolean') {
          errors.push({ path: path || '/', message: `Expected boolean, got ${typeof value}`, value });
        }
        break;
      }
      case 'Literal': {
        if (value !== schema.value && value !== schema.const) {
          errors.push({ path: path || '/', message: `Expected literal ${schema.value}, got ${value}`, value });
        }
        break;
      }
      case 'Union': {
        const unionSchemas: TSchema[] = schema.schemas || schema.anyOf || [];
        const isMatched = unionSchemas.some((s) => Value.Check(s, value));
        if (!isMatched) {
          errors.push({ path: path || '/', message: 'Value did not match any schema in union', value });
        }
        break;
      }
      case 'Object': {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          errors.push({ path: path || '/', message: `Expected object, got ${typeof value}`, value });
        } else {
          const props: Record<string, TSchema> = schema.properties || {};
          for (const [key, propSchema] of Object.entries(props)) {
            const childErrors = Value.Errors(propSchema, value[key], path ? `${path}/${key}` : `/${key}`);
            errors.push(...childErrors);
          }
          if (schema.additionalProperties === false) {
            for (const key of Object.keys(value)) {
              if (!(key in props)) {
                errors.push({ path: path ? `${path}/${key}` : `/${key}`, message: `Unexpected additional property '${key}'`, value: value[key] });
              }
            }
          }
        }
        break;
      }
      case 'Array': {
        if (!Array.isArray(value)) {
          errors.push({ path: path || '/', message: `Expected array, got ${typeof value}`, value });
        } else {
          const itemSchema: TSchema = schema.items;
          for (let i = 0; i < value.length; i++) {
            const itemErrors = Value.Errors(itemSchema, value[i], `${path}[${i}]`);
            errors.push(...itemErrors);
          }
        }
        break;
      }
      case 'Record': {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          errors.push({ path: path || '/', message: `Expected record object, got ${typeof value}`, value });
        } else {
          const valSchema: TSchema = schema.additionalProperties;
          for (const [k, v] of Object.entries(value)) {
            const childErrors = Value.Errors(valSchema, v, `${path}/${k}`);
            errors.push(...childErrors);
          }
        }
        break;
      }
      case 'Unknown':
      case 'Any':
      case 'Unsafe':
        break;
    }

    return errors;
  },

  Cast<T extends TSchema>(schema: T, value: any): Static<T> {
    if (value === undefined || value === null) {
      if (schema.default !== undefined) return schema.default;
      return value;
    }
    return value;
  },

  Clean<T extends TSchema>(schema: T, value: any): any {
    if (schema[TypeBoxKind] === 'Object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const props: Record<string, TSchema> = schema.properties || {};
      const result: Record<string, any> = {};
      for (const [key, propSchema] of Object.entries(props)) {
        if (key in value) {
          result[key] = Value.Clean(propSchema, value[key]);
        }
      }
      return result;
    }
    if (schema[TypeBoxKind] === 'Array' && Array.isArray(value)) {
      return value.map((item) => Value.Clean(schema.items, item));
    }
    return value;
  }
};

export default Type;
