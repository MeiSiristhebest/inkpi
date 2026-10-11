import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InkPiDaemon } from './daemon.js';
import { loadTrustedProjectInstructionFiles } from './project-instructions.js';

let fixtureRoot: string | undefined;
const daemons: InkPiDaemon[] = [];

function createFixture(): string {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inkpi-project-instructions-'));
  return fixtureRoot;
}

function writeInstruction(directory: string, name: string, content: string): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name), content, 'utf8');
}

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

describe('trusted project instructions', () => {
  it('loads files from the trusted root down and lets each directory override its AGENTS.md', () => {
    const root = createFixture();
    const child = path.join(root, 'chapter');
    const project = path.join(child, 'draft');
    writeInstruction(root, 'AGENTS.md', 'Root rules');
    writeInstruction(child, 'AGENTS.md', 'Shadowed child rules');
    writeInstruction(child, 'AGENTS.override.md', 'Child override rules');
    writeInstruction(project, 'AGENTS.md', 'Draft rules');

    const files = loadTrustedProjectInstructionFiles({
      projectRoot: project,
      trustedRoots: [root]
    });

    expect(files.map((file) => file.path)).toEqual([
      'AGENTS.md',
      'chapter/AGENTS.override.md',
      'chapter/draft/AGENTS.md'
    ]);
    expect(files.map((file) => file.content)).toEqual(['Root rules', 'Child override rules', 'Draft rules']);
  });

  it('does not load instructions unless the selected project is inside a trusted root', () => {
    const root = createFixture();
    const untrustedRoot = path.join(root, 'untrusted');
    const project = path.join(untrustedRoot, 'project');
    const unrelatedTrustedRoot = path.join(root, 'trusted');
    writeInstruction(untrustedRoot, 'AGENTS.md', 'Untrusted instructions');
    fs.mkdirSync(unrelatedTrustedRoot, { recursive: true });

    expect(
      loadTrustedProjectInstructionFiles({
        projectRoot: project,
        trustedRoots: [unrelatedTrustedRoot]
      })
    ).toEqual([]);
    expect(
      loadTrustedProjectInstructionFiles({
        projectRoot: project,
        trustedRoots: []
      })
    ).toEqual([]);
    expect(
      loadTrustedProjectInstructionFiles({
        projectRoot: '.',
        trustedRoots: [root]
      })
    ).toEqual([]);
    expect(
      loadTrustedProjectInstructionFiles({
        projectRoot: project,
        trustedRoots: ['.']
      })
    ).toEqual([]);
  });

  it('stops ancestor loading at the most specific trusted root', () => {
    const root = createFixture();
    const narrowerRoot = path.join(root, 'narrow');
    const project = path.join(narrowerRoot, 'project');
    writeInstruction(root, 'AGENTS.md', 'Broader rules');
    writeInstruction(narrowerRoot, 'AGENTS.md', 'Narrower rules');
    writeInstruction(project, 'AGENTS.md', 'Project rules');

    const files = loadTrustedProjectInstructionFiles({
      projectRoot: project,
      trustedRoots: [root, narrowerRoot]
    });

    expect(files.map((file) => file.content)).toEqual(['Narrower rules', 'Project rules']);
  });

  it('lets an empty override shadow AGENTS.md in the same directory', () => {
    const root = createFixture();
    const project = path.join(root, 'project');
    writeInstruction(root, 'AGENTS.md', 'Root rules');
    writeInstruction(project, 'AGENTS.md', 'Project rules');
    writeInstruction(project, 'AGENTS.override.md', '');

    const files = loadTrustedProjectInstructionFiles({
      projectRoot: project,
      trustedRoots: [root]
    });

    expect(files.map((file) => file.content)).toEqual(['Root rules', '']);
    expect(files.map((file) => file.path)).toEqual(['AGENTS.md', 'project/AGENTS.override.md']);
  });

  it('rejects symlink targets outside trusted roots and deduplicates internal symlinks', (context) => {
    const root = createFixture();
    const child = path.join(root, 'child');
    const project = path.join(child, 'draft');
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.md`);
    writeInstruction(root, 'AGENTS.md', 'Root rules');
    writeInstruction(child, 'AGENTS.md', 'Child rules');
    writeInstruction(project, 'AGENTS.md', 'Draft rules');
    fs.writeFileSync(outside, 'Outside rules', 'utf8');

    try {
      fs.unlinkSync(path.join(child, 'AGENTS.md'));
      fs.symlinkSync(path.join(root, 'AGENTS.md'), path.join(child, 'AGENTS.override.md'), 'file');
      fs.unlinkSync(path.join(project, 'AGENTS.md'));
      fs.symlinkSync(outside, path.join(project, 'AGENTS.md'), 'file');
    } catch (error) {
      fs.rmSync(outside, { force: true });
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))
      ) {
        context.skip();
      }
      throw error;
    }

    try {
      const files = loadTrustedProjectInstructionFiles({
        projectRoot: project,
        trustedRoots: [root]
      });
      expect(files.map((file) => file.content)).toEqual(['Root rules']);
      expect(files.filter((file) => file.content === 'Outside rules')).toHaveLength(0);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('loads nested worktree instructions linked to another explicitly trusted root', (context) => {
    const base = createFixture();
    const mainRoot = path.join(base, 'main');
    const worktreeRoot = path.join(base, 'worktree');
    const project = path.join(worktreeRoot, 'chapter');
    const mainInstructions = path.join(mainRoot, 'AGENTS.md');
    const worktreeInstructions = path.join(project, 'AGENTS.md');
    writeInstruction(mainRoot, 'AGENTS.md', 'Main repository rules');
    fs.mkdirSync(project, { recursive: true });

    try {
      fs.symlinkSync(mainInstructions, worktreeInstructions, 'file');
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))
      ) {
        context.skip();
        return;
      }
      throw error;
    }

    expect(
      loadTrustedProjectInstructionFiles({
        projectRoot: project,
        trustedRoots: [worktreeRoot]
      })
    ).toEqual([]);
    expect(
      loadTrustedProjectInstructionFiles({
        projectRoot: project,
        trustedRoots: [mainRoot]
      })
    ).toEqual([]);
    expect(
      loadTrustedProjectInstructionFiles({
        projectRoot: project,
        trustedRoots: [worktreeRoot, mainRoot]
      })
    ).toEqual([{ path: 'chapter/AGENTS.md', content: 'Main repository rules' }]);
  });

  it('adds trusted instructions to daemon project context', async () => {
    const root = createFixture();
    const project = path.join(root, 'project');
    writeInstruction(root, 'AGENTS.md', 'Use the trusted root guidance.');
    fs.mkdirSync(project, { recursive: true });

    const daemon = new InkPiDaemon({
      projectRoot: project,
      trustedProjectRoots: [root]
    });
    daemons.push(daemon);
    const packet = await daemon.getTaskRouter().contextPipeline.build({
      id: 'trusted-instructions-task',
      kind: 'test.instructions',
      input: { text: 'Write a draft.' },
      outputContract: { format: 'text' }
    });

    expect(packet.fragments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'project.instructions',
          kind: 'project-instructions',
          text: expect.stringContaining('Use the trusted root guidance.'),
          metadata: { contextRole: 'project' }
        })
      ])
    );
  });
});
