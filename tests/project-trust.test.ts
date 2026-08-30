import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ProjectTrustManager } from '@inkpi/agent-core';

describe('InkPi Project Trust & Sandbox Security Gate', () => {
  const testTrustFile = path.join(process.cwd(), '.tmp-inkpi-trust.json');

  beforeEach(() => {
    if (fs.existsSync(testTrustFile)) {
      fs.unlinkSync(testTrustFile);
    }
  });

  afterEach(() => {
    if (fs.existsSync(testTrustFile)) {
      fs.unlinkSync(testTrustFile);
    }
  });

  it('should manage trusted projects and assert security permissions', () => {
    const trustManager = new ProjectTrustManager(testTrustFile);
    const mockNovelDir = path.join(process.cwd(), 'novels', 'my-masterpiece');

    expect(trustManager.isTrusted(mockNovelDir)).toBe(false);

    expect(() => {
      trustManager.assertTrusted(mockNovelDir, 'Novel Workspace');
    }).toThrow(/Security Gate.*NOT trusted/);

    // Grant trust
    trustManager.trust(mockNovelDir);
    expect(trustManager.isTrusted(mockNovelDir)).toBe(true);
    expect(() => {
      trustManager.assertTrusted(mockNovelDir, 'Novel Workspace');
    }).not.toThrow();
    expect(trustManager.listTrusted().length).toBe(1);

    // Revoke trust
    trustManager.revoke(mockNovelDir);
    expect(trustManager.isTrusted(mockNovelDir)).toBe(false);

    trustManager.trust(mockNovelDir);
    trustManager.clear();
    expect(trustManager.listTrusted().length).toBe(0);
  });
});
