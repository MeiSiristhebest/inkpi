import * as fs from 'node:fs';
import * as path from 'node:path';
import { ExtensionInstaller, runPackageManagerCli } from '@inkpi/agent-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    const pm = new ExtensionInstaller(testBaseDir);

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
    expect(fs.readFileSync(path.join(testBaseDir, '@inkpi-xianxia-worldview', 'realms.json'), 'utf8')).toContain(
      '元婴'
    );

    // Update
    pm.update(
      '@inkpi/xianxia-worldview',
      {
        ...manifest,
        version: '1.1.0'
      },
      { 'index.js': 'export const version = "1.1.0";' }
    );
    const updatedList = pm.getInstalledPackages();
    expect(updatedList[0].version).toBe('1.1.0');
    expect(fs.existsSync(path.join(testBaseDir, '@inkpi-xianxia-worldview', 'realms.json'))).toBe(false);
    expect(fs.readFileSync(path.join(testBaseDir, '@inkpi-xianxia-worldview', 'index.js'), 'utf8')).toContain('1.1.0');

    // Remove
    const removed = pm.trash('@inkpi/xianxia-worldview');
    expect(removed).toBe(true);
    expect(pm.getInstalledPackages().length).toBe(0);
  });

  it('should execute package manager CLI commands', async () => {
    const cliBaseDir = path.join(testBaseDir, 'cli');
    const bundle = {
      manifest: {
        name: '@inkpi/test-pkg',
        version: '2.3.4',
        description: 'Test bundle from a configured source',
        category: 'plugins' as const
      },
      files: { 'index.js': 'export const value = 42;' }
    };
    const resolvePackage = async () => bundle;

    const listRes = await runPackageManagerCli(['list'], { baseDir: cliBaseDir, resolvePackage });
    expect(typeof listRes).toBe('string');

    const missingSourceRes = await runPackageManagerCli(['install', '@inkpi/test-pkg'], { baseDir: cliBaseDir });
    expect(missingSourceRes).toContain('No package source resolver');

    const installRes = await runPackageManagerCli(['install', '@inkpi/test-pkg'], {
      baseDir: cliBaseDir,
      resolvePackage
    });
    expect(installRes).toContain("Installed '@inkpi/test-pkg'@2.3.4");

    const updateRes = await runPackageManagerCli(['update', '@inkpi/test-pkg'], {
      baseDir: cliBaseDir,
      resolvePackage
    });
    expect(updateRes).toContain("Updated '@inkpi/test-pkg' to v2.3.4");

    const removeRes = await runPackageManagerCli(['remove', '@inkpi/test-pkg'], {
      baseDir: cliBaseDir,
      resolvePackage
    });
    expect(removeRes).toContain('Removed');
  });

  it('should reject invalid manifests and file paths before touching an existing package', () => {
    const pm = new ExtensionInstaller(testBaseDir);
    const manifest = {
      name: '@inkpi/stable',
      version: '1.0.0',
      description: 'Stable package',
      category: 'plugin'
    };
    pm.install(manifest, { 'state.json': '{"ok":true}' });

    expect(() =>
      pm.update(
        '@inkpi/stable',
        {
          ...manifest,
          version: 'not-semver'
        },
        { 'state.json': '{"ok":false}' }
      )
    ).toThrow(/Invalid package version/);
    expect(fs.readFileSync(path.join(testBaseDir, '@inkpi-stable', 'state.json'), 'utf8')).toBe('{"ok":true}');

    expect(() =>
      pm.install(
        {
          ...manifest,
          version: '1.0.1'
        },
        { '../escape.js': 'must not be written' }
      )
    ).toThrow(/escapes package directory/);
    expect(fs.existsSync(path.join(testBaseDir, 'escape.js'))).toBe(false);
  });

  it('should expose malformed installed package manifests through diagnostics', () => {
    const pm = new ExtensionInstaller(testBaseDir);
    const malformedDir = path.join(testBaseDir, 'broken');
    fs.mkdirSync(malformedDir, { recursive: true });
    fs.writeFileSync(path.join(malformedDir, 'package.json'), '{"name":"broken"}', 'utf8');

    expect(pm.getInstalledPackages()).toEqual([]);
    const diagnostics = pm.getDiagnostics();
    expect(diagnostics.malformedPackages).toHaveLength(1);
    expect(diagnostics.malformedPackages[0].directory).toBe(malformedDir);
    expect(diagnostics.malformedPackages[0].error.message).toMatch(/version|category/i);
  });

  it('should reject manifest validation failures and handle CLI fallback commands', async () => {
    const pm = new ExtensionInstaller(testBaseDir);

    expect(() => (pm as any).validateManifest(null, {})).toThrow('Package manifest must be an object');
    expect(() => (pm as any).validateManifest({ name: '' }, {})).toThrow('name must not be empty');
    expect(() => (pm as any).validateManifest({ name: 'pkg', version: '1.0.0', category: '' }, {})).toThrow(
      'category must not be empty'
    );
    expect(() =>
      (pm as any).validateManifest({ name: 'pkg', version: '1.0.0', category: 'plugin', description: 123 as any }, {})
    ).toThrow('description must be a string');
    expect(() =>
      (pm as any).validateManifest({ name: 'pkg', version: '1.0.0', category: 'plugin', files: [123 as any] }, {})
    ).toThrow('files must be an array of paths');
    expect(() => pm.update('pkg1', { name: 'pkg2', version: '1.0.0', category: 'plugin' })).toThrow(
      'Package name mismatch'
    );

    // CLI branch tests
    const helpRes = await runPackageManagerCli(['help'], { baseDir: testBaseDir });
    expect(helpRes).toContain('Usage: inkpi');

    const unknownRes = await runPackageManagerCli(['unknown_cmd'], { baseDir: testBaseDir });
    expect(unknownRes).toContain('Usage: inkpi');

    const missingPkgInstall = await runPackageManagerCli(['install'], { baseDir: testBaseDir });
    expect(missingPkgInstall).toContain('A package name is required');

    const missingPkgRemove = await runPackageManagerCli(['remove'], { baseDir: testBaseDir });
    expect(missingPkgRemove).toContain('A package name is required');

    const missingPkgUpdate = await runPackageManagerCli(['update'], { baseDir: testBaseDir });
    expect(missingPkgUpdate).toContain('A package name is required');

    const noBundleRes = await runPackageManagerCli(['install', 'missing_bundle'], {
      baseDir: testBaseDir,
      resolvePackage: async () => undefined
    });
    expect(noBundleRes).toContain('No package manifest/source was resolved');

    const mismatchedBundleRes = await runPackageManagerCli(['install', 'pkg_a'], {
      baseDir: testBaseDir,
      resolvePackage: async () => ({ manifest: { name: 'pkg_b', version: '1.0.0', category: 'plugin' } })
    });
    expect(mismatchedBundleRes).toContain('does not match');
  });
});
