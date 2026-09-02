/**
 * 跨平台系统原生剪贴板与 KillRing 同步器
 */

import { execFileSync } from 'node:child_process';
import type { KillRing } from './kill-ring.js';

export interface ClipboardDriver {
  readText(): string;
  writeText(text: string): boolean;
}

export type ClipboardCommandRunner = (
  executable: string,
  args: readonly string[],
  options: Record<string, unknown>
) => string | Buffer;

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
  constructor(
    private readonly commandRunner: ClipboardCommandRunner = execFileSync as ClipboardCommandRunner,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  public readText(): string {
    try {
      if (this.platform === 'win32') {
        return String(
          this.commandRunner('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard'], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 1000
          })
        ).trimEnd();
      }
      if (this.platform === 'darwin') {
        return String(
          this.commandRunner('pbpaste', [], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 1000 })
        );
      }
      if (this.platform === 'linux') {
        try {
          return String(
            this.commandRunner('wl-paste', [], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 1000 })
          );
        } catch (waylandError) {
          try {
            return String(
              this.commandRunner('xclip', ['-selection', 'clipboard', '-o'], {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: 1000
              })
            );
          } catch (xclipError) {
            throw new Error('No supported Linux clipboard command is available.', { cause: xclipError });
          }
        }
      }
      throw new Error(`Native clipboard is unsupported on platform '${this.platform}'.`);
    } catch (error) {
      throw new Error(`Unable to read the native system clipboard: ${(error as Error).message}`, { cause: error });
    }
  }

  public writeText(text: string): boolean {
    try {
      if (this.platform === 'win32') {
        this.commandRunner(
          'powershell.exe',
          ['-NoProfile', '-Command', '$value = [Console]::In.ReadToEnd(); Set-Clipboard -Value $value'],
          { input: text, stdio: ['pipe', 'pipe', 'pipe'], timeout: 1000 }
        );
        return true;
      }
      if (this.platform === 'darwin') {
        this.commandRunner('pbcopy', [], { input: text, stdio: ['pipe', 'pipe', 'pipe'], timeout: 1000 });
        return true;
      }
      if (this.platform === 'linux') {
        try {
          this.commandRunner('wl-copy', [], { input: text, stdio: ['pipe', 'pipe', 'pipe'], timeout: 1000 });
        } catch (waylandError) {
          try {
            this.commandRunner('xclip', ['-selection', 'clipboard'], {
              input: text,
              stdio: ['pipe', 'pipe', 'pipe'],
              timeout: 1000
            });
          } catch (xclipError) {
            throw new Error('No supported Linux clipboard command is available.', { cause: xclipError });
          }
        }
        return true;
      }
      throw new Error(`Native clipboard is unsupported on platform '${this.platform}'.`);
    } catch (error) {
      throw new Error(`Unable to write to the native system clipboard: ${(error as Error).message}`, { cause: error });
    }
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
    if (!this.driver.writeText(text)) {
      throw new Error('Clipboard driver rejected the write operation.');
    }
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
