/**
 * 项目与第三方扩展信任沙箱
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TrustStoreFile {
  trustedDirectories: string[];
  lastUpdated: number;
}

export interface TrustDiagnostics {
  loadError?: Error;
}

export class ProjectTrustManager {
  private configPath: string;
  private memoryStore: Set<string> = new Set();
  private diagnostics: TrustDiagnostics = {};

  constructor(configPath = '.inkpi/trusted-projects.json') {
    if (typeof configPath !== 'string' || configPath.trim().length === 0) {
      throw new TypeError('ProjectTrustManager requires a non-empty config path.');
    }
    this.configPath = configPath;
    this.load();
  }

  private load(): void {
    if (fs.existsSync(this.configPath)) {
      try {
        const raw: unknown = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        const dirs = this.parseTrustedDirectories(raw);
        this.memoryStore = new Set(dirs.map((directory) => path.resolve(directory)));
      } catch (error) {
        this.memoryStore = new Set();
        this.diagnostics.loadError = error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  private parseTrustedDirectories(raw: unknown): string[] {
    const directories = Array.isArray(raw)
      ? raw
      : typeof raw === 'object' && raw !== null && 'trustedDirectories' in raw
        ? (raw as { trustedDirectories?: unknown }).trustedDirectories
        : undefined;

    if (!Array.isArray(directories) || directories.some((directory) => typeof directory !== 'string')) {
      throw new TypeError('Trust configuration must contain a trustedDirectories array of strings.');
    }

    return directories;
  }

  private save(): void {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data: TrustStoreFile = {
      trustedDirectories: Array.from(this.memoryStore),
      lastUpdated: Date.now()
    };
    fs.writeFileSync(this.configPath, JSON.stringify(data, null, 2), 'utf8');
  }

  public isTrusted(projectOrExtensionPath: string): boolean {
    const resolved = path.resolve(projectOrExtensionPath);
    return this.memoryStore.has(resolved);
  }

  public trust(projectOrExtensionPath: string): void {
    const resolved = path.resolve(projectOrExtensionPath);
    const wasTrusted = this.memoryStore.has(resolved);
    this.memoryStore.add(resolved);
    try {
      this.save();
    } catch (error) {
      if (!wasTrusted) this.memoryStore.delete(resolved);
      throw error;
    }
  }

  public revoke(projectOrExtensionPath: string): void {
    const resolved = path.resolve(projectOrExtensionPath);
    const wasTrusted = this.memoryStore.has(resolved);
    this.memoryStore.delete(resolved);
    try {
      this.save();
    } catch (error) {
      if (wasTrusted) this.memoryStore.add(resolved);
      throw error;
    }
  }

  public assertTrusted(projectOrExtensionPath: string, context = 'Extension'): void {
    if (!this.isTrusted(projectOrExtensionPath)) {
      throw new Error(`🛡️ [Security Gate] ${context} at '${projectOrExtensionPath}' is NOT trusted. User confirmation required before execution.`);
    }
  }

  public listTrusted(): string[] {
    return Array.from(this.memoryStore);
  }

  public getDiagnostics(): TrustDiagnostics {
    return { ...this.diagnostics };
  }

  public clear(): void {
    const previous = new Set(this.memoryStore);
    this.memoryStore.clear();
    try {
      this.save();
    } catch (error) {
      this.memoryStore = previous;
      throw error;
    }
  }
}
