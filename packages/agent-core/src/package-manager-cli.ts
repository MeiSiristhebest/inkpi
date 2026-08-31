/**
 * InkPi 扩展包管理命令行分发器 (1:1 对标 pi-coding-agent package-manager-cli.ts)
 */

import { ExtensionPackageManager, type InkPackageBundle } from './package-manager/package-manager.js';

export interface PackageManagerCliOptions {
  baseDir?: string;
  resolvePackage?: (pkgName: string, operation: 'install' | 'update') => Promise<InkPackageBundle | undefined> | InkPackageBundle | undefined;
}

export async function runPackageManagerCli(args: string[], options: PackageManagerCliOptions = {}): Promise<string> {
  const [subcommand, pkgName] = args;
  const pm = new ExtensionPackageManager(options.baseDir);

  switch (subcommand) {
    case 'list': {
      const pkgs = pm.getInstalledPackages();
      if (pkgs.length === 0) {
        return 'No extension packages are installed.';
      }
      return [
        'Installed extension packages:',
        ...pkgs.map((p) => `  • ${p.name}@${p.version} (${p.category}): ${p.description}`)
      ].join('\n');
    }

    case 'install': {
      if (!pkgName) return 'A package name is required: inkpi install <package>';
      if (!options.resolvePackage) return `No package source resolver is configured for '${pkgName}'.`;
      const bundle = await options.resolvePackage(pkgName, 'install');
      if (!bundle) return `No package manifest/source was resolved for '${pkgName}'.`;
      if (bundle.manifest.name !== pkgName) return `Resolved manifest '${bundle.manifest.name}' does not match '${pkgName}'.`;
      pm.install(bundle.manifest, bundle.files);
      return `Installed '${pkgName}'@${bundle.manifest.version}.`;
    }

    case 'remove': {
      if (!pkgName) return 'A package name is required: inkpi remove <package>';
      const removed = pm.remove(pkgName);
      return removed ? `Removed '${pkgName}'.` : `Package '${pkgName}' is not installed.`;
    }

    case 'update': {
      if (!pkgName) return 'A package name is required: inkpi update <package>';
      if (!options.resolvePackage) return `No package source resolver is configured for '${pkgName}'.`;
      const bundle = await options.resolvePackage(pkgName, 'update');
      if (!bundle) return `No package manifest/source was resolved for '${pkgName}'.`;
      if (bundle.manifest.name !== pkgName) return `Resolved manifest '${bundle.manifest.name}' does not match '${pkgName}'.`;
      pm.update(pkgName, bundle.manifest, bundle.files);
      return `Updated '${pkgName}' to v${bundle.manifest.version}.`;
    }

    default:
      return 'Usage: inkpi <install|remove|list|update> [package]';
  }
}
