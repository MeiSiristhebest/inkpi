export const STORAGE_SCHEMA_DDL = `
-- 1. Workspaces (工作空间表)
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  owner TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  target_size INTEGER DEFAULT 0,
  synopsis TEXT,
  cover_image TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 2. Folders (目录/文件夹/分卷表)
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_folders_workspace_id ON folders(workspace_id, order_index);

-- 3. Documents (文档/章节/场次表)
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  synopsis TEXT,
  content_size INTEGER DEFAULT 0,
  status TEXT DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_documents_folder_id ON documents(folder_id, order_index);
CREATE INDEX IF NOT EXISTS idx_documents_workspace_id ON documents(workspace_id, order_index);

-- 4. Document Snapshots (文档基线快照表)
CREATE TABLE IF NOT EXISTS document_snapshots (
  document_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  content_markdown TEXT NOT NULL,
  content_size INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- 5. Document Deltas (LSM 击键增量日志表)
CREATE TABLE IF NOT EXISTS document_deltas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL,
  step_json TEXT NOT NULL,
  client_timestamp INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_document_deltas_lookup ON document_deltas(document_id, created_at);

-- 6. Writer Leases (多进程排他写锁租约表)
CREATE TABLE IF NOT EXISTS writer_leases (
  id TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  metadata TEXT
);

-- 7. FTS5 Full Text Search Virtual Table (全文检索虚拟表)
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  document_id UNINDEXED,
  title,
  content,
  tokenize = 'unicode61'
);

-- 8. FTS5 Synchronization Triggers (快照更新自动同步全文检索)
CREATE TRIGGER IF NOT EXISTS trg_snapshots_ai AFTER INSERT ON document_snapshots
BEGIN
  INSERT INTO documents_fts(document_id, title, content)
  SELECT new.document_id, c.title, new.content_markdown
  FROM documents c WHERE c.id = new.document_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_snapshots_ad AFTER DELETE ON document_snapshots
BEGIN
  DELETE FROM documents_fts WHERE document_id = old.document_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_snapshots_au AFTER UPDATE ON document_snapshots
BEGIN
  DELETE FROM documents_fts WHERE document_id = old.document_id;
  INSERT INTO documents_fts(document_id, title, content)
  SELECT new.document_id, c.title, new.content_markdown
  FROM documents c WHERE c.id = new.document_id;
END;

-- 9. Lanes (多泳道/平行分支线表 - 1:1 对标 pi-session lanes)
CREATE TABLE IF NOT EXISTS lanes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_default INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lanes_workspace_id ON lanes(workspace_id);

-- 10. Branch Tips (分支游标/快照版本追踪表 - 1:1 对标 pi branch-tips)
CREATE TABLE IF NOT EXISTS branch_tips (
  lane_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  head_snapshot_version INTEGER NOT NULL,
  last_delta_id INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (lane_id, document_id),
  FOREIGN KEY (lane_id) REFERENCES lanes(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- 11. Session Compaction Records (会话阶段压缩与账本快照表)
CREATE TABLE IF NOT EXISTS session_compaction_records (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  ledger_json TEXT NOT NULL,
  tokens_before INTEGER DEFAULT 0,
  tokens_after INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compaction_session_id ON session_compaction_records(session_id);
`;

