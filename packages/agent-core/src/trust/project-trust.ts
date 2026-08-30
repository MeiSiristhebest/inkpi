/**
 * 项目与第三方扩展信任沙箱 (1:1 对标 pi project-trust.ts & TrustSelectorComponent)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TrustStoreData {
  trustedDirectories: string[];
  lastUpdated: number;
}

export class ProjectTrustManager {
  private configPath: string;
  private memoryStore: Set<string> = new Set();

  constructor(configPath = '.inkpi/trusted-projects.json') {
    this.configPath = configPath;
    this.load();
  }

  private load(): void {
    if (fs.existsSync(this.configPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        const dirs = Array.isArray(raw) ? raw : (raw?.trustedDirectories || []);
        this.memoryStore = new Set(dirs.map((d: string) => path.resolve(d)));
      } catch {
        this.memoryStore = new Set();
      }
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data: TrustStoreData = {
        trustedDirectories: Array.from(this.memoryStore),
        lastUpdated: Date.now()
      };
      fs.writeFileSync(this.configPath, JSON.stringify(data, null, 2), 'utf8');
    } catch {
      // Ignore in mock/test environments
    }
  }

  public isTrusted(projectOrExtensionPath: string): boolean {
    const resolved = path.resolve(projectOrExtensionPath);
    return this.memoryStore.has(resolved);
  }

  public trust(projectOrExtensionPath: string): void {
    const resolved = path.resolve(projectOrExtensionPath);
    this.memoryStore.add(resolved);
    this.save();
  }

  public revoke(projectOrExtensionPath: string): void {
    const resolved = path.resolve(projectOrExtensionPath);
    this.memoryStore.delete(resolved);
    this.save();
  }

  public assertTrusted(projectOrExtensionPath: string, context = 'Extension'): void {
    if (!this.isTrusted(projectOrExtensionPath)) {
      throw new Error(`🛡️ [Security Gate] ${context} at '${projectOrExtensionPath}' is NOT trusted. User confirmation required before execution.`);
    }
  }

  public listTrusted(): string[] {
    return Array.from(this.memoryStore);
  }

  public clear(): void {
    this.memoryStore.clear();
    this.save();
  }
}
