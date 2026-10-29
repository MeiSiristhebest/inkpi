#!/usr/bin/env node

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MODEL_CATALOG_ENTRY_SCHEMA, MODEL_CATALOG_SCHEMA } from '../packages/ai/src/catalog-schema.ts';
import { PROJECT_CONFIG_SCHEMA } from '../bin/project-config-schema.js';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..');
const DEFAULT_ARTIFACTS = renderGeneratedArtifacts();

export function renderGeneratedArtifacts() {
  return new Map([
    ['schemas/inkpi.config.schema.json', `${JSON.stringify(PROJECT_CONFIG_SCHEMA, null, 2)}\n`],
    ['schemas/model-catalog.schema.json', `${JSON.stringify(MODEL_CATALOG_SCHEMA, null, 2)}\n`],
    ['docs/config-reference.md', renderReference()]
  ]);
}

export async function checkGeneratedArtifacts(root = repositoryRoot, artifacts = DEFAULT_ARTIFACTS) {
  const drifted = [];
  for (const [relativePath, expected] of artifacts) {
    try {
      const actual = await readFile(path.join(root, relativePath), 'utf8');
      if (actual !== expected) drifted.push(relativePath);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        drifted.push(relativePath);
      } else {
        throw error;
      }
    }
  }
  return drifted;
}

export async function writeGeneratedArtifacts(root = repositoryRoot, artifacts = DEFAULT_ARTIFACTS) {
  for (const [relativePath, content] of artifacts) {
    const targetPath = path.join(root, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, 'utf8');
  }
}

function renderReference() {
  const configRows = schemaRows(PROJECT_CONFIG_SCHEMA, { expandAlternatives: true });
  const modelRows = schemaRows(MODEL_CATALOG_ENTRY_SCHEMA);
  return [
    '# InkPi 配置与模型目录参考',
    '',
    '> 本文和两份 JSON Schema 由 `node scripts/generate-config-reference.mjs` 离线生成。不要手动编辑生成文件。',
    '',
    '## `inkpi.config.json`',
    '',
    '`$schema` 是编辑器元数据；CLI 不会联网获取 schema。仓库内配置可使用下列相对路径，路径按配置文件所在目录解析：',
    '',
    '```json',
    '{',
    '  "$schema": "./schemas/inkpi.config.schema.json"',
    '}',
    '```',
    '',
    '配置字段均为可选项。顶层及 `typography` 对象会保留既有的扩展字段接受语义；新增 Schema 不改变运行时默认值。',
    '',
    ...renderTable(configRows),
    '',
    '## 模型目录 JSON 数据',
    '',
    '`packages/ai/src/models-data.json` 是模型目录数据（`ModelCatalogEntry[]`），并不是项目配置入口；本 Schema 不增加 `models.json` 配置文件或加载路径。',
    '',
    '模型目录 JSON Schema：[`../schemas/model-catalog.schema.json`](../schemas/model-catalog.schema.json)。',
    '',
    ...renderTable(modelRows),
    '',
    '价格 sentinel、重复 prompt-length 阈值、必需能力以及 structured/patch 输出一致性等语义规则仍由现有运行时验证器负责。',
    ''
  ].join('\n');
}

function schemaRows(schema, { expandAlternatives = false } = {}) {
  const properties = schema.properties ?? (expandAlternatives ? findObjectAlternative(schema)?.properties : undefined) ?? {};
  const required = new Set(schema.required ?? []);
  const rows = [];
  for (const [name, property] of Object.entries(properties)) {
    const nestedPath = name;
    const objectAlternative = findObjectAlternative(property);
    const type = describeSchemaType(property);
    rows.push({
      path: nestedPath,
      type,
      required: required.has(name) ? '是' : '否',
      description: property.description ?? ''
    });
    if (objectAlternative?.properties) {
      for (const [childName, child] of Object.entries(objectAlternative.properties)) {
        rows.push({
          path: `${nestedPath}.${childName}`,
          type: describeSchemaType(child),
          required: (objectAlternative.required ?? []).includes(childName) ? '是' : '否',
          description: child.description ?? ''
        });
      }
    }
  }
  return rows;
}

function findObjectAlternative(schema) {
  if (schema?.type === 'object') return schema;
  const alternatives = [...(schema?.oneOf ?? []), ...(schema?.anyOf ?? [])];
  return alternatives.find((alternative) => alternative.type === 'object');
}

function describeSchemaType(schema) {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(' / ');
  if (schema.oneOf) return schema.oneOf.map(describeSchemaType).join(' 或 ');
  if (schema.anyOf) return schema.anyOf.map(describeSchemaType).join(' 或 ');
  if (schema.type === 'array') return `数组<${describeSchemaType(schema.items ?? {})}>`;
  if (schema.type === 'object') return '对象';
  if (schema.type) return schema.type;
  return '任意 JSON 值';
}

function renderTable(rows) {
  return [
    '| 字段 | 结构类型 | 必需 | 说明 |',
    '| --- | --- | --- | --- |',
    ...rows.map(({ path, type, required, description }) =>
      `| \`${path}\` | ${escapeCell(type)} | ${required} | ${escapeCell(description)} |`
    )
  ];
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

async function main() {
  const args = process.argv.slice(2);
  const unknownArgs = args.filter((argument) => argument !== '--check');
  if (unknownArgs.length > 0 || args.filter((argument) => argument === '--check').length > 1) {
    console.error('Usage: node scripts/generate-config-reference.mjs [--check]');
    process.exitCode = 2;
    return;
  }

  const artifacts = renderGeneratedArtifacts();
  if (args.includes('--check')) {
    const drifted = await checkGeneratedArtifacts(repositoryRoot, artifacts);
    if (drifted.length > 0) {
      console.error(`Generated configuration reference is out of date: ${drifted.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Generated configuration reference is current (${artifacts.size} files).`);
    return;
  }

  await writeGeneratedArtifacts(repositoryRoot, artifacts);
  console.log(`Generated configuration schemas and reference (${artifacts.size} files).`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(scriptPath).href) {
  await main();
}
