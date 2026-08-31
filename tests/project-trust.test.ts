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

  it('should surface persistence failures instead of reporting trust changes as durable', () => {
    const invalidConfigPath = process.cwd();
    const trustManager = new ProjectTrustManager(invalidConfigPath);
    const projectDir = path.join(process.cwd(), 'workspace');

    expect(() => trustManager.trust(projectDir)).toThrow();
    expect(trustManager.isTrusted(projectDir)).toBe(false);
  });

  it('should expose corrupted trust configuration instead of treating it as an empty store', () => {
    fs.writeFileSync(testTrustFile, '{ bad json', 'utf8');
    const trustManager = new ProjectTrustManager(testTrustFile);

    expect(trustManager.listTrusted()).toEqual([]);
    expect(trustManager.getDiagnostics().loadError?.message).toMatch(/Unexpected|JSON|position/i);
  });

  it('should reject malformed trusted directory entries', () => {
    fs.writeFileSync(testTrustFile, JSON.stringify({ trustedDirectories: [42] }), 'utf8');
    const trustManager = new ProjectTrustManager(testTrustFile);

    expect(trustManager.listTrusted()).toEqual([]);
    expect(trustManager.getDiagnostics().loadError?.message).toMatch(/trustedDirectories.*strings/i);
  });

  it('should restore the previous trust state when revoke or clear persistence fails', () => {
    const projectDir = path.join(process.cwd(), 'workspace');
    const otherProjectDir = path.join(process.cwd(), 'other-workspace');
    const trustManager = new ProjectTrustManager(testTrustFile);
    trustManager.trust(projectDir);
    trustManager.trust(otherProjectDir);

    // Point persistence at an existing directory so the native write fails.
    // This exercises the real filesystem failure path without mocking fs.
    (trustManager as any).configPath = process.cwd();

    expect(() => trustManager.revoke(projectDir)).toThrow();
    expect(trustManager.isTrusted(projectDir)).toBe(true);

    expect(() => trustManager.clear()).toThrow();
    expect(trustManager.isTrusted(projectDir)).toBe(true);
    expect(trustManager.isTrusted(otherProjectDir)).toBe(true);
  });

  it('should read durable trust state when a manager is recreated', () => {
    const projectDir = path.join(process.cwd(), 'workspace');
    const first = new ProjectTrustManager(testTrustFile);
    first.trust(projectDir);

    const second = new ProjectTrustManager(testTrustFile);
    expect(second.isTrusted(projectDir)).toBe(true);
    expect(second.listTrusted()).toEqual([path.resolve(projectDir)]);
  });
});
