# InkPi 配置与模型目录参考

> 本文和两份 JSON Schema 由 `node scripts/generate-config-reference.mjs` 离线生成。不要手动编辑生成文件。

## `inkpi.config.json`

`$schema` 是编辑器元数据；CLI 不会联网获取 schema。仓库内配置可使用下列相对路径，路径按配置文件所在目录解析：

```json
{
  "$schema": "./schemas/inkpi.config.schema.json"
}
```

配置字段均为可选项。顶层及 `typography` 对象会保留既有的扩展字段接受语义；新增 Schema 不改变运行时默认值。

| 字段 | 结构类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `$schema` | 任意 JSON 值 | 否 | Optional editor metadata. The CLI does not fetch or validate this value; use a relative schema path where possible. |
| `name` | string | 否 | Optional project name. Must contain a non-whitespace character. |
| `version` | string | 否 | Optional project version label. InkPi does not enforce semantic-version syntax. |
| `defaultModel` | string | 否 | Optional default model identifier; runtime availability is resolved separately. |
| `plugins` | 数组<string> | 否 | Optional plugin identifiers. |
| `typography` | false 或 对象 | 否 | Optional typography settings, or false to disable typography formatting. |
| `typography.mode` | "chinese" / "western" / "none" | 否 | Optional typography mode. |
| `typography.indentString` | string | 否 | Optional indentation string used by typography formatting. |

## 模型目录 JSON 数据

`packages/ai/src/models-data.json` 是模型目录数据（`ModelCatalogEntry[]`），并不是项目配置入口；本 Schema 不增加 `models.json` 配置文件或加载路径。

模型目录 JSON Schema：[`../schemas/model-catalog.schema.json`](../schemas/model-catalog.schema.json)。

| 字段 | 结构类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | Stable catalog identifier. |
| `name` | string | 是 | Human-readable model name. |
| `provider` | string | 是 | Provider identifier. |
| `contextWindow` | number | 是 | Maximum input context tokens. |
| `maxTokens` | number | 是 | Maximum output tokens. |
| `supportsThinking` | boolean | 是 | Whether the model supports reasoning output. |
| `supportsTools` | boolean | 是 | Whether the model supports tool calls. |
| `supportsVision` | boolean | 否 | Optional image-input capability. |
| `supportsMidConvoEffort` | boolean | 否 | Optional support for per-turn reasoning-effort changes. |
| `cost` | 对象 | 是 |  |
| `cost.inputPerMillionUsd` | number 或 -1000000 | 是 |  |
| `cost.outputPerMillionUsd` | number 或 -1000000 | 是 |  |
| `cost.cacheReadPerMillionUsd` | number 或 -1000000 | 否 |  |
| `cost.cacheWritePerMillionUsd` | number 或 -1000000 | 否 |  |
| `cost.serviceTierRates` | 对象 | 否 |  |
| `cost.promptLengthTiers` | 数组<对象> | 否 |  |
| `cost.cacheWritePerMillionUsdByTtl` | 对象 | 否 |  |
| `capabilities` | 对象 | 否 |  |
| `capabilities.capabilities` | 数组<string> | 否 |  |
| `capabilities.network` | "offline" / "optional" / "required" | 否 |  |
| `capabilities.modalities` | 数组<string> | 否 |  |
| `capabilities.outputFormats` | 数组<"text" / "structured" / "patch"> | 否 |  |
| `capabilities.streaming` | boolean | 否 |  |
| `capabilities.contextTokens` | number | 否 |  |
| `capabilities.maxOutputTokens` | number | 否 |  |
| `capabilities.tools` | boolean | 否 |  |
| `capabilities.reasoning` | boolean | 否 |  |
| `capabilities.structuredOutput` | boolean | 否 |  |
| `capabilities.patchOutput` | boolean | 否 |  |
| `capabilities.jsonSchema` | boolean | 否 |  |
| `capabilities.promptCaching` | boolean | 否 |  |
| `description` | string | 否 | Optional catalog description. |
| `roles` | 数组<"planning" / "drafting" / "auditing" / "polishing"> | 否 | Optional recommended task roles. |
| `priority` | number | 否 | Optional preference within a role; higher values win. |

价格 sentinel、重复 prompt-length 阈值、必需能力以及 structured/patch 输出一致性等语义规则仍由现有运行时验证器负责。
