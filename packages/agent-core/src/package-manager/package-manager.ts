/** Durable local package storage for extension bundles. */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface InkPackageManifest {
  name: string;
  version: string;
  description?: string;
  category: string;
  author?: string;
  dependencies?: Record<string, string>;
  files?: string[];
}

export interface InkPackageBundle {
  manifest: InkPackageManifest;
  files?: Record<string, string>;
}

export interface PackageManagerDiagnostics {
  malformedPackages: Array<{ directory: string; error: Error }>;
}

export class ExtensionInstaller {
  private baseDir: string;
  private diagnostics: PackageManagerDiagnostics = { malformedPackages: [] };
  private operationSequence = 0;

  constructor(baseDir = '.inkpi/extensions') {
    this.baseDir = path.resolve(baseDir);
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  public getInstalledPackages(): InkPackageManifest[] {
    this.diagnostics = { malformedPackages: [] };
    const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
    const manifests: InkPackageManifest[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.staging' || entry.name === '.trash') continue;
      const packageDir = path.join(this.baseDir, entry.name);
      const pkgJson = path.join(packageDir, 'package.json');
      if (!fs.existsSync(pkgJson)) continue;
      try {
        manifests.push(this.readManifest(pkgJson));
      } catch (error) {
        this.diagnostics.malformedPackages.push({
          directory: packageDir,
          error: error instanceof Error ? error : new Error(String(error))
        });
      }
    }

    return manifests;
  }

  public getDiagnostics(): PackageManagerDiagnostics {
    return {
      malformedPackages: this.diagnostics.malformedPackages.map((item) => ({ ...item }))
    };
  }

  public install(manifest: InkPackageManifest, files: Record<string, string> = {}): boolean {
    this.validateManifest(manifest, files);
    const pkgDir = this.packageDirectory(manifest.name);
    const stagingDir = this.createOperationDirectory('.staging');
    let backupDir: string | undefined;

    try {
      this.writeBundle(stagingDir, manifest, files);
      if (fs.existsSync(pkgDir)) {
        backupDir = this.uniqueQuarantinePath('replace');
        fs.renameSync(pkgDir, backupDir);
      }
      try {
        fs.renameSync(stagingDir, pkgDir);
      } catch (error) {
        if (backupDir && fs.existsSync(backupDir)) {
          fs.renameSync(backupDir, pkgDir);
        }
        throw error;
      }
      return true;
    } catch (error) {
      if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * 将已安装的扩展移入隔离区（.trash），不立即物理删除。
   * 命名说明：此操作是"移入回收站"而非"彻底删除"，故命名为 trash 而非 remove/purge。
   */
  public trash(pkgName: string): boolean {
    const pkgDir = this.packageDirectory(pkgName);
    if (fs.existsSync(pkgDir)) {
      const quarantinePath = this.uniqueQuarantinePath(path.basename(pkgDir));
      fs.renameSync(pkgDir, quarantinePath);
      return true;
    }
    return false;
  }

  public update(pkgName: string, newManifest: InkPackageManifest, newFiles?: Record<string, string>): boolean {
    if (pkgName !== newManifest.name) {
      throw new Error(`Package name mismatch: '${pkgName}' vs '${newManifest.name}'.`);
    }
    return this.install(newManifest, newFiles);
  }

  private packageDirectory(pkgName: string): string {
    const safeName = pkgName.replace(/[/\\?%*:|"<>]/g, '-');
    const pkgDir = path.resolve(this.baseDir, safeName);
    const relative = path.relative(this.baseDir, pkgDir);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Invalid package name '${pkgName}'.`);
    }
    return pkgDir;
  }

  private safeFilePath(pkgDir: string, filename: string): string {
    const filePath = path.resolve(pkgDir, filename);
    const relative = path.relative(pkgDir, filePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Package file path escapes package directory: '${filename}'.`);
    }
    return filePath;
  }

  private validateManifest(manifest: InkPackageManifest, files: Record<string, string>): void {
    if (!manifest || typeof manifest !== 'object') throw new Error('Package manifest must be an object.');
    if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
      throw new Error('Package manifest name must not be empty.');
    }
    if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) {
      throw new Error(`Invalid package version '${manifest.version}'.`);
    }
    if (typeof manifest.category !== 'string' || !manifest.category.trim()) {
      throw new Error('Package manifest category must not be empty.');
    }
    if (manifest.description !== undefined && typeof manifest.description !== 'string') {
      throw new Error('Package manifest description must be a string when provided.');
    }
    if (manifest.files !== undefined) {
      if (!Array.isArray(manifest.files) || manifest.files.some((file) => typeof file !== 'string')) {
        throw new Error('Package manifest files must be an array of paths.');
      }
      for (const filename of manifest.files) this.safeFilePath(this.baseDir, filename);
    }
    for (const filename of Object.keys(files)) this.safeFilePath(this.baseDir, filename);
  }

  private writeBundle(directory: string, manifest: InkPackageManifest, files: Record<string, string>): void {
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
    for (const [filename, content] of Object.entries(files)) {
      const filePath = this.safeFilePath(directory, filename);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf8');
    }
  }

  private createOperationDirectory(kind: '.staging'): string {
    const directory = path.join(this.baseDir, kind);
    fs.mkdirSync(directory, { recursive: true });
    const operationDirectory = path.join(directory, `${process.pid}-${Date.now()}-${++this.operationSequence}`);
    fs.mkdirSync(operationDirectory, { recursive: true });
    return operationDirectory;
  }

  private uniqueQuarantinePath(label: string): string {
    const trashDir = path.join(this.baseDir, '.trash');
    fs.mkdirSync(trashDir, { recursive: true });
    let attempt = 0;
    let candidate: string;
    do {
      candidate = path.join(trashDir, `${label}-${process.pid}-${Date.now()}-${++this.operationSequence + attempt}`);
      attempt++;
    } while (fs.existsSync(candidate));
    return candidate;
  }

  private readManifest(pkgJson: string): InkPackageManifest {
    const parsed: unknown = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    this.validateManifest(parsed as InkPackageManifest, {});
    return parsed as InkPackageManifest;
  }
}
