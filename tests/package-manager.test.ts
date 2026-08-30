import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ExtensionPackageManager, runPackageManagerCli } from '@inkpi/agent-core';

describe('InkPi Extension Package Manager', () => {
  const testBaseDir = path.join(process.cwd(), '.tmp-inkpi-extensions-test');

  beforeEach(() => {
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true, force: true });
    }
  });

  it('should install, list, update, and remove packages', () => {
    const pm = new ExtensionPackageManager(testBaseDir);

    expect(pm.getInstalledPackages().length).toBe(0);

    // Install
    const manifest = {
      name: '@inkpi/xianxia-worldview',
      version: '1.0.0',
      description: '仙侠大世界观设定与境界划分',
      category: 'worldview' as const
    };
    pm.install(manifest, {
      'realms.json': JSON.stringify(['练气', '筑基', '金丹', '元婴', '化神'])
    });

    const list = pm.getInstalledPackages();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe('@inkpi/xianxia-worldview');

    // Update
    pm.update('@inkpi/xianxia-worldview', {
      ...manifest,
      version: '1.1.0'
    });
    const updatedList = pm.getInstalledPackages();
    expect(updatedList[0].version).toBe('1.1.0');

    // Remove
    const removed = pm.remove('@inkpi/xianxia-worldview');
    expect(removed).toBe(true);
    expect(pm.getInstalledPackages().length).toBe(0);
  });

  it('should execute package manager CLI commands', async () => {
    const listRes = await runPackageManagerCli(['list']);
    expect(typeof listRes).toBe('string');

    const installRes = await runPackageManagerCli(['install', '@inkpi/test-pkg']);
    expect(installRes).toContain('成功安装');

    const updateRes = await runPackageManagerCli(['update', '@inkpi/test-pkg']);
    expect(updateRes).toContain('成功更新');

    const removeRes = await runPackageManagerCli(['remove', '@inkpi/test-pkg']);
    expect(removeRes).toContain('成功卸载');
  });
});
