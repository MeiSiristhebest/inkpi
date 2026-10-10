import { KillRing, MockClipboardDriver, NativeSystemClipboardDriver, SyncedClipboard } from '@inkpi/agent-core';
import { describe, expect, it } from 'vitest';

function missingExecutable(name: string): Error {
  return Object.assign(new Error(`${name} was not found`), { code: 'ENOENT' });
}

describe('InkPi System Clipboard Integration & KillRing Sync', () => {
  it('should sync copied text from KillRing to Clipboard driver', () => {
    const ring = new KillRing(10);
    const mockDriver = new MockClipboardDriver();
    const synced = new SyncedClipboard(ring, mockDriver);

    synced.copy('段落 1：剑光如雪');
    expect(mockDriver.readText()).toBe('段落 1：剑光如雪');
    expect(ring.peek()).toBe('段落 1：剑光如雪');
    expect(synced.getKillRing()).toBe(ring);

    synced.copy('段落 2：天劫降临');
    expect(mockDriver.readText()).toBe('段落 2：天劫降临');
    expect(ring.peek()).toBe('段落 2：天劫降临');
  });

  it('should sync external clipboard updates on paste', () => {
    const ring = new KillRing(10);
    const mockDriver = new MockClipboardDriver();
    const synced = new SyncedClipboard(ring, mockDriver);

    mockDriver.writeText('外部浏览器复制的素材');
    const pasted = synced.paste();
    expect(pasted).toBe('外部浏览器复制的素材');
    expect(ring.peek()).toBe('外部浏览器复制的素材');
  });

  it('should execute native clipboard commands and preserve arbitrary text without a memory fallback', () => {
    const calls: Array<{ executable: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    let clipboard = '';
    const native = new NativeSystemClipboardDriver((executable, args, options) => {
      calls.push({ executable, args, options });
      if (args.at(-1) === 'Get-Clipboard') return clipboard;
      clipboard = String(options.input || '');
      return '';
    }, 'win32');

    expect(native.writeText("quotes ' and $variables")).toBe(true);
    expect(native.readText()).toBe("quotes ' and $variables");
    expect(calls.map((call) => call.executable)).toEqual(['powershell.exe', 'powershell.exe']);
  });

  it('should report native clipboard failure instead of returning an in-memory value', () => {
    const native = new NativeSystemClipboardDriver(() => {
      throw new Error('clipboard unavailable');
    }, 'win32');

    expect(() => native.readText()).toThrow(/Unable to read the native system clipboard/);
    expect(() => native.writeText('text')).toThrow(/Unable to write to the native system clipboard/);
  });

  it('should prefer Wayland clipboard commands when available', () => {
    const calls: Array<{ executable: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    const native = new NativeSystemClipboardDriver((executable, args, options) => {
      calls.push({ executable, args, options });
      return executable === 'wl-paste' ? 'wayland text' : '';
    }, 'linux');

    expect(native.readText()).toBe('wayland text');
    expect(native.writeText('copy to Wayland')).toBe(true);
    expect(calls.map((call) => call.executable)).toEqual(['wl-paste', 'wl-copy']);
    expect(calls.every((call) => call.options.timeout === 1000)).toBe(true);
  });

  it('should use X11 clipboard commands only when the Wayland executable is missing', () => {
    const calls: Array<{ executable: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    let clipboard = '';
    const native = new NativeSystemClipboardDriver((executable, args, options) => {
      calls.push({ executable, args, options });
      if (executable === 'wl-paste' || executable === 'wl-copy') throw missingExecutable(executable);
      if (args.at(-1) === '-o') return clipboard;
      clipboard = String(options.input ?? '');
      return '';
    }, 'linux');

    expect(native.writeText('copy to X11')).toBe(true);
    expect(native.readText()).toBe('copy to X11');
    expect(calls.map((call) => call.executable)).toEqual(['wl-copy', 'xclip', 'wl-paste', 'xclip']);
    expect(calls[1]?.args).toEqual(['-selection', 'clipboard']);
    expect(calls[3]?.args).toEqual(['-selection', 'clipboard', '-o']);
  });

  it('should surface a Wayland operation failure without writing to a different X11 clipboard', () => {
    const calls: string[] = [];
    const denied = Object.assign(new Error('clipboard permission denied'), { code: 'EACCES' });
    const native = new NativeSystemClipboardDriver((executable) => {
      calls.push(executable);
      if (executable === 'wl-copy') throw denied;
      return '';
    }, 'linux');

    expect(() => native.writeText('text')).toThrow(/clipboard permission denied/);
    expect(calls).toEqual(['wl-copy']);
  });
});
