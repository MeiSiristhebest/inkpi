import { describe, it, expect } from 'vitest';
import { KillRing, MockClipboardDriver, SyncedClipboard, NativeSystemClipboardDriver } from '@meisiristhebest/agent-core';

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

    expect(native.writeText("quotes ' and $variables" )).toBe(true);
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
});
