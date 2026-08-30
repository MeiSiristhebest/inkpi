/**
 * InkPi 扩展包管理命令行分发器 (1:1 对标 pi-coding-agent package-manager-cli.ts)
 */

import { ExtensionPackageManager, type InkPackageManifest } from './package-manager/package-manager.js';

export async function runPackageManagerCli(args: string[]): Promise<string> {
  const [subcommand, pkgName] = args;
  const pm = new ExtensionPackageManager();

  switch (subcommand) {
    case 'list': {
      const pkgs = pm.getInstalledPackages();
      if (pkgs.length === 0) {
        return '📦 当前未安装任何 InkPi 创作扩展或世界观技能包。';
      }
      return [
        '📦 已安装的 InkPi 创作扩展：',
        ...pkgs.map((p) => `  • ${p.name}@${p.version} (${p.category}): ${p.description}`)
      ].join('\n');
    }

    case 'install': {
      if (!pkgName) return '❌ 请提供要安装的包名，例如: inkpi install @inkpi/wuxia-worldview';
      const mockManifest: InkPackageManifest = {
        name: pkgName,
        version: '1.0.0',
        description: `Community package ${pkgName}`,
        category: 'worldview'
      };
      pm.install(mockManifest, {
        'rules.md': `# ${pkgName} 创作规则与世界观设定\n1. 角色境界划分\n2. 势力分布`,
        'index.js': `export default { name: "${pkgName}", init() { console.log("${pkgName} loaded"); } };`
      });
      return `✅ 成功安装扩展包 '${pkgName}'@1.0.0`;
    }

    case 'remove': {
      if (!pkgName) return '❌ 请提供要卸载的包名，例如: inkpi remove @inkpi/wuxia-worldview';
      const removed = pm.remove(pkgName);
      return removed ? `✅ 成功卸载扩展包 '${pkgName}'` : `⚠️ 未找到扩展包 '${pkgName}'`;
    }

    case 'update': {
      if (!pkgName) return '❌ 请提供要更新的包名，例如: inkpi update @inkpi/wuxia-worldview';
      const updatedManifest: InkPackageManifest = {
        name: pkgName,
        version: '1.1.0',
        description: `Updated package ${pkgName}`,
        category: 'worldview'
      };
      pm.update(pkgName, updatedManifest);
      return `✅ 成功更新扩展包 '${pkgName}' 至 v1.1.0`;
    }

    default:
      return '用法: inkpi <install|remove|list|update> [pkgName]';
  }
}
