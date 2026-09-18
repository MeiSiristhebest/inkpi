import { describe, expect, it } from "vitest";
import {
  InkDb,
  InkRepository,
  SqliteArtifactStore,
  DomainProjectionStore,
  LaneManager,
} from "@inkpi/storage";
import { InkPiDaemon } from "./daemon.js";

describe("workspace.purge RPC and keyword retrieval", () => {
  it("purges documents, artifacts, domain changes, and lanes via workspace.purge RPC", async () => {
    const db = new InkDb(":memory:");
    const repo = new InkRepository(db);
    const artifactStore = new SqliteArtifactStore(db);
    const domainProjection = new DomainProjectionStore(db);
    const laneManager = new LaneManager(db);

    const workspaceId = "ws-purge-test";

    // Seed workspace data
    repo.createWorkspace({
      id: workspaceId,
      title: "Purge Target",
      owner: "test",
      targetSize: 0,
      createdAt: 100,
      updatedAt: 100,
    });
    repo.createFolder({
      id: "folder-1",
      workspaceId,
      title: "Vol 1",
      orderIndex: 0,
      createdAt: 100,
      updatedAt: 100,
    });
    repo.createDocument({
      id: "doc-1",
      workspaceId,
      folderId: "folder-1",
      title: "Chapter 1",
      orderIndex: 0,
      contentSize: 10,
      status: "draft",
      createdAt: 100,
      updatedAt: 100,
    });
    repo.upsertSnapshot({
      documentId: "doc-1",
      version: 1,
      contentJson: "{}",
      contentMarkdown: "hello purge test content",
      contentSize: 24,
      updatedAt: 100,
    });

    // Seed artifact
    artifactStore.save({
      id: "art-1",
      workspaceId,
      type: "test.artifact",
      version: 1,
      content: { foo: "bar" },
      provenance: { workspaceId },
      createdAt: 100,
      updatedAt: 100,
    });

    // Seed lane
    laneManager.createLane({
      id: "lane-1",
      workspaceId,
      name: "Test Lane",
      isDefault: true,
      createdAt: 100,
      updatedAt: 100,
    });

    const daemon = new InkPiDaemon({
      context: {
        storage: repo,
        artifactStore,
        domainProjection,
        laneManager,
      },
    });

    try {
      expect(repo.getDocument("doc-1")).toBeDefined();
      expect(artifactStore.get("art-1")).toBeDefined();
      expect(artifactStore.list(undefined, workspaceId)).toHaveLength(1);

      // Invoke workspace.purge directly through RPC server or client
      const rpcServer = (daemon as any).rpcServer;
      const purgeResponse = await rpcServer.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "workspace.purge",
        params: { workspaceId },
      });

      expect(purgeResponse.result).toMatchObject({
        success: true,
        workspaceId,
        purgedRecords: {
          documents: 1,
          folders: 1,
          documentSnapshots: 1,
          artifacts: 1,
          lanes: 1,
        },
      });

      // Verify records are gone
      expect(repo.getDocument("doc-1")).toBeUndefined();
      expect(repo.getFolders(workspaceId)).toHaveLength(0);
      expect(artifactStore.get("art-1")).toBeUndefined();
      expect(artifactStore.list(undefined, workspaceId)).toHaveLength(0);
    } finally {
      await daemon.stop();
      db.close();
    }
  });
});
