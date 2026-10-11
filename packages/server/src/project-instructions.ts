import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ContextFragment, ContextProvider } from '@inkpi/agent-core';

export const PROJECT_INSTRUCTIONS_PROVIDER_ID = 'project.instructions';

export interface ProjectInstructionFile {
  path: string;
  content: string;
}

export interface TrustedProjectInstructionOptions {
  projectRoot: string;
  trustedRoots: readonly string[];
}

/**
 * Read AGENTS files only when the selected project is inside a host-trusted root.
 * Ancestor files are composed from the trusted root down to the project root.
 */
export function loadTrustedProjectInstructionFiles(
  options: TrustedProjectInstructionOptions
): ProjectInstructionFile[] {
  const projectRoot = resolveExistingDirectory(options.projectRoot);
  if (!projectRoot) return [];

  const trustedRoots = new Map<string, string>();
  for (const candidate of options.trustedRoots) {
    const root = resolveExistingDirectory(candidate);
    if (root) trustedRoots.set(pathKey(root), root);
  }

  const trustedRootPaths = [...trustedRoots.values()];
  const trustedRoot = trustedRootPaths
    .filter((root) => isPathWithin(root, projectRoot))
    .sort((left, right) => path.relative(left, projectRoot).length - path.relative(right, projectRoot).length)[0];
  if (!trustedRoot) return [];

  const directories: string[] = [];
  let currentDirectory = projectRoot;
  while (isPathWithin(trustedRoot, currentDirectory)) {
    directories.unshift(currentDirectory);
    if (samePath(currentDirectory, trustedRoot)) break;
    const parent = path.dirname(currentDirectory);
    if (samePath(parent, currentDirectory)) return [];
    currentDirectory = parent;
  }
  if (!directories.length || !samePath(directories[0], trustedRoot)) return [];

  const seenRealPaths = new Set<string>();
  const files: ProjectInstructionFile[] = [];
  for (const directory of directories) {
    for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
      const candidate = path.join(directory, name);
      const loaded = readTrustedInstructionFile(candidate, trustedRoot, trustedRootPaths);
      if (!loaded) continue;
      if (!seenRealPaths.has(pathKey(loaded.realPath))) {
        seenRealPaths.add(pathKey(loaded.realPath));
        files.push(loaded.file);
      }
      // An override shadows AGENTS.md in the same directory even when its real
      // path was already loaded from another directory.
      break;
    }
  }

  return files;
}

export function createTrustedProjectInstructionsProvider(
  options: TrustedProjectInstructionOptions
): ContextProvider | undefined {
  const files = loadTrustedProjectInstructionFiles(options);
  if (!files.length) return undefined;

  const fragments: ContextFragment[] = files.map((file) => ({
    id: `${PROJECT_INSTRUCTIONS_PROVIDER_ID}:${file.path}`,
    source: PROJECT_INSTRUCTIONS_PROVIDER_ID,
    kind: 'project-instructions',
    text: `Instructions from ${file.path}:\n${file.content}`,
    priority: 1000,
    metadata: { contextRole: 'project' }
  }));

  return {
    id: PROJECT_INSTRUCTIONS_PROVIDER_ID,
    bucket: 'project',
    provide: () =>
      fragments.map((fragment) => ({
        ...fragment,
        metadata: { ...fragment.metadata }
      }))
  };
}

function resolveExistingDirectory(value: string): string | undefined {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) return undefined;
  try {
    const resolved = fs.realpathSync(path.resolve(value));
    return fs.statSync(resolved).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function readTrustedInstructionFile(
  candidate: string,
  trustedRoot: string,
  trustedRoots: readonly string[]
): { file: ProjectInstructionFile; realPath: string } | undefined {
  try {
    const realPath = fs.realpathSync(candidate);
    if (!trustedRoots.some((root) => isPathWithin(root, realPath)) || !fs.statSync(realPath).isFile()) return undefined;
    const content = fs.readFileSync(realPath, 'utf8').replace(/^\uFEFF/, '');
    return {
      realPath,
      file: {
        path: path.relative(trustedRoot, candidate).split(path.sep).join('/'),
        content
      }
    };
  } catch {
    return undefined;
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  return path.relative(left, right) === '';
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}
