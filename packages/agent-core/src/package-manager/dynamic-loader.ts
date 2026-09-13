import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtensionAPI, ExtensionFactory } from '@inkpi/protocol';
import { consoleLogger } from '../ports/index.js';

export interface DynamicLoadSummary {
  loaded: string[];
  failed: Array<{ path: string; error: Error }>;
}

/**
 * 现代零编译动态插件加载器 (Dynamic Plugin Loader)
 * 允许用户将创作插件 (.js / .mjs / 包含 package.json 的子模块) 放入 .inkpi/plugins/
 * 系统启动或热重载时动态挂载生命周期钩子、自定义工具与斜杠指令。
 */
export class DynamicPluginLoader {
  private extensionHost: ExtensionAPI;

  constructor(extensionHost: ExtensionAPI) {
    this.extensionHost = extensionHost;
  }

  /**
   * 自动同时扫描并加载默认的插件与扩展目录（.inkpi/plugins 与 .inkpi/extensions）
   */
  public async loadDefaultDirectories(baseRoot = '.'): Promise<DynamicLoadSummary> {
    const combined: DynamicLoadSummary = { loaded: [], failed: [] };
    const dirsToScan = [path.join(baseRoot, '.inkpi', 'plugins'), path.join(baseRoot, '.inkpi', 'extensions')];

    for (const d of dirsToScan) {
      const res = await this.loadFromDirectory(d);
      combined.loaded.push(...res.loaded);
      combined.failed.push(...res.failed);
    }

    return combined;
  }

  /**
   * 扫描目标目录并动态载入所有合规的插件
   */
  public async loadFromDirectory(dirPath = '.inkpi/plugins'): Promise<DynamicLoadSummary> {
    const summary: DynamicLoadSummary = { loaded: [], failed: [] };
    const resolvedDir = path.resolve(dirPath);

    if (!fs.existsSync(resolvedDir)) {
      return summary;
    }

    const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });

    for (const entry of entries) {
      const isScript = entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'));
      const isSubmodule = entry.isDirectory() && fs.existsSync(path.join(resolvedDir, entry.name, 'package.json'));

      if (!isScript && !isSubmodule) continue;

      const fullPath = path.join(resolvedDir, entry.name);
      try {
        let entryFile = fullPath;
        if (isSubmodule) {
          const pkgJsonPath = path.join(fullPath, 'package.json');
          const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
          const mainFile = pkg.module || pkg.main || 'index.js';
          entryFile = path.join(fullPath, mainFile);
        }

        // 安全执行插件模块解析：
        // 1. 如果是 CommonJS 规范或包含 exports/module.exports
        // 2. 如果是 ESM 规范，优先通过 data: 或原生 require/import
        let factory: ExtensionFactory | undefined;

        const fileContent = fs.readFileSync(entryFile, 'utf8');
        if (entryFile.endsWith('.cjs') || fileContent.includes('module.exports') || fileContent.includes('exports.')) {
          const { createRequire } = await import('node:module');
          const requireFn = createRequire(import.meta.url);
          const cjsMod = requireFn(entryFile);
          factory = cjsMod.default || cjsMod.extension || cjsMod.activate || cjsMod;
        } else {
          // 纯文本 ESM 模块转为 Base64 Data URL 导入，规避 Vite/打包器的文件系统拦截
          const base64Code = Buffer.from(fileContent).toString('base64');
          const dataUrl = `data:text/javascript;base64,${base64Code}`;
          const esmMod = await import(/* @vite-ignore */ dataUrl);
          factory = esmMod.default || esmMod.extension || esmMod.activate;
        }

        if (typeof factory === 'function') {
          await factory(this.extensionHost);
          summary.loaded.push(entry.name);
          consoleLogger.info(`[DynamicPluginLoader] Successfully mounted plugin: ${entry.name}`);
        } else {
          throw new Error(`Plugin '${entry.name}' does not export a default factory function or 'activate'.`);
        }
      } catch (err: any) {
        const error = err instanceof Error ? err : new Error(String(err));
        summary.failed.push({ path: fullPath, error });
        consoleLogger.error(`[DynamicPluginLoader] Failed to load plugin '${entry.name}':`, error);
      }
    }

    return summary;
  }
}
