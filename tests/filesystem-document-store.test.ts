import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileSystemDocumentStore, ToolRegistry, createAuthoringTools } from '@inkpi/agent-core';
import { describe, expect, it } from 'vitest';

describe('@inkpi/agent-core: FileSystemDocumentStore & Desktop Workspace Bridge', () => {
  it('should read, write, list and search actual files on disk', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkpi-fs-doc-test-'));

    try {
      const store = new FileSystemDocumentStore(tempDir);
      const tools = createAuthoringTools(store);
      const registry = new ToolRegistry();
      for (const t of tools) registry.register(t);

      // 1. write_draft -> 真实写入磁盘文件
      const writeRes = await registry.executeTool({
        type: 'toolCall',
        id: 'c1',
        name: 'write_draft',
        arguments: {
          documentId: 'chapter_01',
          content: '第一章 天元大陆\n少年萧晨立于山巅，怀揣神秘残图。',
          mode: 'create'
        }
      });
      expect(writeRes.isError).toBe(false);

      // 验证磁盘上真实生成了 chapter_01.md
      const diskPath = path.join(tempDir, 'chapter_01.md');
      expect(fs.existsSync(diskPath)).toBe(true);
      expect(fs.readFileSync(diskPath, 'utf8')).toContain('天元大陆');

      // 2. read_chapter -> 从磁盘读取
      const readRes = await registry.executeTool({
        type: 'toolCall',
        id: 'c2',
        name: 'read_chapter',
        arguments: { documentId: 'chapter_01' }
      });
      expect(readRes.isError).toBe(false);
      expect((readRes.content[0] as any).text).toContain('神秘残图');

      // 3. edit_text -> 磁盘文件局部模糊修改
      const editRes = await registry.executeTool({
        type: 'toolCall',
        id: 'c3',
        name: 'edit_text',
        arguments: {
          documentId: 'chapter_01',
          oldText: '怀揣神秘残图。',
          newText: '紧握一卷古朴竹简。'
        }
      });
      expect(editRes.isError).toBe(false);

      // 验证磁盘内容被安全更新
      const updatedDisk = fs.readFileSync(diskPath, 'utf8');
      expect(updatedDisk).toContain('紧握一卷古朴竹简');
      expect(updatedDisk).toContain('第一章 天元大陆');

      // 4. search_story_memory -> 磁盘文件伏笔全文匹配
      const searchRes = await registry.executeTool({
        type: 'toolCall',
        id: 'c4',
        name: 'search_story_memory',
        arguments: { query: '古朴竹简' }
      });
      expect(searchRes.isError).toBe(false);
      expect((searchRes.content[0] as any).text).toContain('古朴竹简');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
