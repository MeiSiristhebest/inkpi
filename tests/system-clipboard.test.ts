import { describe, it, expect } from 'vitest';
import { KillRing, MockClipboardDriver, SyncedClipboard, NativeSystemClipboardDriver } from '@inkpi/agent-core';

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

  it('should test native driver fallback safely', () => {
    const native = new NativeSystemClipboardDriver();
    expect(typeof native.readText()).toBe('string');
    expect(typeof native.writeText('测试复制')).toBe('boolean');
  });
});
