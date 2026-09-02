/**
 * InkPi 核心 TypeBox 协议与数据结构 Schema
 */

import { type Static, Type } from './typebox.js';

export const PROTOCOL_VERSION = 1 as const;

// 1. 基础标识与时间戳
export const IdSchema = Type.String({ minLength: 1 });
export const TimestampSchema = Type.Integer({ minimum: 0 });

// 2. 思考预算分级
export const ThinkingLevelSchema = Type.Union([
  Type.Literal('off'),
  Type.Literal('minimal'),
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('xhigh'),
  Type.Literal('max')
]);
export type ThinkingLevelType = Static<typeof ThinkingLevelSchema>;

// 3. Token 用量与成本
export const UsageSchema = Type.Object({
  inputTokens: Type.Integer({ minimum: 0 }),
  outputTokens: Type.Integer({ minimum: 0 }),
  totalTokens: Type.Integer({ minimum: 0 }),
  reasoningTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  cacheReadTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  cacheWriteTokens: Type.Optional(Type.Integer({ minimum: 0 }))
});
export type UsageType = Static<typeof UsageSchema>;

// 4. 内容块 Schemas
export const TextContentSchema = Type.Object({
  type: Type.Literal('text'),
  text: Type.String()
});

export const ThinkingContentSchema = Type.Object({
  type: Type.Literal('thinking'),
  thinking: Type.String()
});

export const ImageContentSchema = Type.Object({
  type: Type.Literal('image'),
  image: Type.String(),
  mimeType: Type.Optional(Type.String())
});

export const ToolCallContentSchema = Type.Object({
  type: Type.Literal('toolCall'),
  id: IdSchema,
  name: Type.String({ minLength: 1 }),
  arguments: Type.Record(Type.String(), Type.Any())
});

export const ContentBlockSchema = Type.Union([
  TextContentSchema,
  ThinkingContentSchema,
  ImageContentSchema,
  ToolCallContentSchema
]);

// 5. 消息模型 Schemas
export const UserMessageSchema = Type.Object({
  id: Type.Optional(IdSchema),
  role: Type.Literal('user'),
  content: Type.Union([Type.String(), Type.Array(Type.Union([TextContentSchema, ImageContentSchema]))]),
  timestamp: Type.Optional(TimestampSchema)
});

export const AssistantMessageSchema = Type.Object({
  id: Type.Optional(IdSchema),
  role: Type.Literal('assistant'),
  content: Type.Array(ContentBlockSchema),
  stopReason: Type.Optional(
    Type.Union([
      Type.Literal('stop'),
      Type.Literal('tool_use'),
      Type.Literal('length'),
      Type.Literal('error'),
      Type.Literal('aborted')
    ])
  ),
  errorMessage: Type.Optional(Type.String()),
  usage: Type.Optional(UsageSchema),
  timestamp: Type.Optional(TimestampSchema)
});

export const ToolResultMessageSchema = Type.Object({
  id: Type.Optional(IdSchema),
  role: Type.Literal('toolResult'),
  toolCallId: IdSchema,
  toolName: Type.String({ minLength: 1 }),
  content: Type.Array(Type.Union([TextContentSchema, ImageContentSchema])),
  isError: Type.Optional(Type.Boolean()),
  timestamp: Type.Optional(TimestampSchema)
});

export const SystemMessageSchema = Type.Object({
  id: Type.Optional(IdSchema),
  role: Type.Literal('system'),
  content: Type.String(),
  timestamp: Type.Optional(TimestampSchema)
});

export const CustomMessageSchema = Type.Object({
  id: Type.Optional(IdSchema),
  role: Type.Literal('custom'),
  customType: Type.String({ minLength: 1 }),
  content: Type.Any(),
  timestamp: Type.Optional(TimestampSchema)
});

export const AgentMessageSchema = Type.Union([
  UserMessageSchema,
  AssistantMessageSchema,
  ToolResultMessageSchema,
  SystemMessageSchema,
  CustomMessageSchema
]);

// 6. 通用状态账本 Schemas (Entity / Asset / Track / Resource)
export const EntityStateSchema = Type.Object({
  id: Type.Optional(IdSchema),
  name: Type.String({ minLength: 1 }),
  type: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  affiliation: Type.Optional(Type.String()),
  relationship: Type.Optional(Type.String()),
  attributes: Type.Optional(Type.Record(Type.String(), Type.Any())),
  aliases: Type.Optional(Type.Array(Type.String())),
  location: Type.Optional(Type.String())
});
export const CharacterStateSchema = EntityStateSchema;

export const AssetStateSchema = Type.Object({
  id: Type.Optional(IdSchema),
  name: Type.String({ minLength: 1 }),
  holder: Type.Optional(Type.String()),
  owner: Type.Optional(Type.String()),
  type: Type.Optional(Type.String()),
  state: Type.Optional(Type.String()),
  attributes: Type.Optional(Type.Record(Type.String(), Type.Any()))
});
export const AssetTrackSchema = AssetStateSchema;

export const TrackStateSchema = Type.Object({
  id: Type.Optional(IdSchema),
  clue: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Any()))
});
export const PlotThreadSchema = TrackStateSchema;

export const LocationStateSchema = Type.Object({
  id: Type.Optional(IdSchema),
  name: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  attributes: Type.Optional(Type.Record(Type.String(), Type.Any()))
});

export const StateLedgerSchema = Type.Object({
  entities: Type.Optional(Type.Array(EntityStateSchema)),
  assets: Type.Optional(Type.Array(AssetStateSchema)),
  tracks: Type.Optional(Type.Array(TrackStateSchema)),
  locations: Type.Optional(Type.Array(LocationStateSchema)),
  modifiedResources: Type.Optional(Type.Array(Type.String())),
  characters: Type.Optional(Type.Array(EntityStateSchema)),
  items: Type.Optional(Type.Array(AssetStateSchema)),
  foreshadowings: Type.Optional(Type.Array(TrackStateSchema))
});

// 7. JSON-RPC 2.0 帧 Schemas
export const RpcRequestSchema = Type.Object({
  jsonrpc: Type.Literal('2.0'),
  id: Type.Union([Type.String(), Type.Number()]),
  method: Type.String({ minLength: 1 }),
  params: Type.Optional(Type.Any())
});

export const RpcResponseSchema = Type.Object({
  jsonrpc: Type.Literal('2.0'),
  id: Type.Union([Type.String(), Type.Number(), Type.Null()]),
  result: Type.Optional(Type.Any()),
  error: Type.Optional(
    Type.Object({
      code: Type.Integer(),
      message: Type.String(),
      data: Type.Optional(Type.Any())
    })
  )
});

export const RpcNotificationSchema = Type.Object({
  jsonrpc: Type.Literal('2.0'),
  method: Type.String({ minLength: 1 }),
  params: Type.Optional(Type.Any())
});
