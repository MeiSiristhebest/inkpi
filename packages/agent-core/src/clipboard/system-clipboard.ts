/**
 * 跨平台系统原生剪贴板与 KillRing 同步器 (1:1 对标 pi native clipboard)
 */

import { execSync } from 'node:child_process';
import type { KillRing } from './kill-ring.js';

export interface ClipboardDriver {
  readText(): string;
  writeText(text: string): boolean;
}

export class MockClipboardDriver implements ClipboardDriver {
  private memory = '';
  public readText(): string {
    return this.memory;
  }
  public writeText(text: string): boolean {
    this.memory = text;
    return true;
  }
}

export class NativeSystemClipboardDriver implements ClipboardDriver {
  private fallback = new MockClipboardDriver();

  public readText(): string {
    try {
      if (process.platform === 'win32') {
        return execSync('powershell.exe -NoProfile -Command "Get-Clipboard"', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 1000 }).trimEnd();
      }
      if (process.platform === 'darwin') {
        return execSync('pbpaste', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 1000 });
      }
      if (process.platform === 'linux') {
        try {
          return execSync('wl-paste', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 1000 });
        } catch {
          return execSync('xclip -selection clipboard -o', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 1000 });
        }
      }
    } catch {
      // Fallback
    }
    return this.fallback.readText();
  }

  public writeText(text: string): boolean {
    try {
      if (process.platform === 'win32') {
        const escaped = text.replace(/'/g, "''");
        execSync(`powershell.exe -NoProfile -Command "Set-Clipboard -Value '${escaped}'"`, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 1000 });
        this.fallback.writeText(text);
        return true;
      }
      if (process.platform === 'darwin') {
        execSync('pbcopy', { input: text, stdio: ['pipe', 'pipe', 'ignore'], timeout: 1000 });
        this.fallback.writeText(text);
        return true;
      }
      if (process.platform === 'linux') {
        try {
          execSync('wl-copy', { input: text, stdio: ['pipe', 'pipe', 'ignore'], timeout: 1000 });
        } catch {
          execSync('xclip -selection clipboard', { input: text, stdio: ['pipe', 'pipe', 'ignore'], timeout: 1000 });
        }
        this.fallback.writeText(text);
        return true;
      }
    } catch {
      // Fallback
    }
    return this.fallback.writeText(text);
  }
}

export class SyncedClipboard {
  private driver: ClipboardDriver;
  private killRing: KillRing;

  constructor(killRing: KillRing, driver?: ClipboardDriver) {
    this.killRing = killRing;
    this.driver = driver || new NativeSystemClipboardDriver();
  }

  public copy(text: string): void {
    this.killRing.push(text);
    this.driver.writeText(text);
  }

  public paste(): string {
    const sysText = this.driver.readText();
    if (sysText && sysText !== this.killRing.peek()) {
      this.killRing.push(sysText);
    }
    return this.killRing.peek() || sysText || '';
  }

  public getKillRing(): KillRing {
    return this.killRing;
  }
}
