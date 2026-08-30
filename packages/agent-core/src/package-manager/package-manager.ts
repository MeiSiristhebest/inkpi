/**
 * InkPi 小说创作扩展与技能包管理器 (1:1 对标 pi package-manager-cli)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface InkPackageManifest {
  name: string;
  version: string;
  description: string;
  category: 'worldview' | 'style' | 'character-templates' | 'skills' | 'rules';
  author?: string;
  dependencies?: Record<string, string>;
  files?: string[];
}

export class ExtensionPackageManager {
  private baseDir: string;

  constructor(baseDir = '.inkpi/extensions') {
    this.baseDir = baseDir;
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  public getInstalledPackages(): InkPackageManifest[] {
    if (!fs.existsSync(this.baseDir)) return [];
    const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
    const manifests: InkPackageManifest[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const pkgJson = path.join(this.baseDir, entry.name, 'package.json');
        if (fs.existsSync(pkgJson)) {
          try {
            const parsed = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
            manifests.push(parsed);
          } catch {
            // Ignore malformed
          }
        }
      }
    }

    return manifests;
  }

  public install(manifest: InkPackageManifest, files: Record<string, string> = {}): boolean {
    const pkgDir = path.join(this.baseDir, manifest.name.replace(/[/\\?%*:|"<>]/g, '-'));
    fs.mkdirSync(pkgDir, { recursive: true });

    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );

    for (const [filename, content] of Object.entries(files)) {
      const filePath = path.join(pkgDir, filename);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf8');
    }

    return true;
  }

  public remove(pkgName: string): boolean {
    const pkgDir = path.join(this.baseDir, pkgName.replace(/[/\\?%*:|"<>]/g, '-'));
    if (fs.existsSync(pkgDir)) {
      fs.rmSync(pkgDir, { recursive: true, force: true });
      return true;
    }
    return false;
  }

  public update(pkgName: string, newManifest: InkPackageManifest, newFiles?: Record<string, string>): boolean {
    this.remove(pkgName);
    return this.install(newManifest, newFiles);
  }
}
