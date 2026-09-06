/**
 * Node.js 基础设施文件系统适配器
 * 从 packages/agent-core/src/ports/index.ts 剥离至独立适配器文件，
 * 保证领域核心端口声明（ports/index.ts）彻底纯净、零 Node.js 基础设施依赖（DIP / Hexagonal）。
 */

import * as nodeFs from 'node:fs';
import type { FileSystem } from '../ports/index.js';

export const nodeFileSystem: FileSystem = {
  existsSync: (p) => nodeFs.existsSync(p),
  mkdirSync: (p, o) => nodeFs.mkdirSync(p, o),
  readFileSync: (p, e) => nodeFs.readFileSync(p, e),
  readdirSync: (p) => nodeFs.readdirSync(p),
  renameSync: (o, n) => nodeFs.renameSync(o, n),
  rmSync: (p, o) => nodeFs.rmSync(p, o),
  writeFileSync: (p, d) => nodeFs.writeFileSync(p, d)
};
