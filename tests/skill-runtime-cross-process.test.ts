import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InkRpcClient } from '@inkpi/client';
import type {
  InstructionRegistryStatus,
  SkillActivationResult,
  SkillLoadResult,
  SkillManifest,
  SkillRuntimeRegistrationSnapshot
} from '@inkpi/protocol';
import { afterEach, describe, expect, it } from 'vitest';

type ChildEvent = { type: string; [key: string]: unknown };

const firstPartySkillIds = ['hook', 'promise', 'character-voice', 'timeline-consistency'] as const;
const firstPartySkillCapabilities: Record<(typeof firstPartySkillIds)[number], string[]> = {
  hook: ['narrative-hook', 'creative-writing'],
  promise: ['story-promise', 'continuity-audit'],
  'character-voice': ['character-voice', 'creative-writing'],
  'timeline-consistency': ['timeline-consistency', 'continuity-audit']
};

interface RunningDaemon {
  child: ChildProcess;
  port: number;
}

const repositoryRoot = resolve(__dirname, '..');
const firstPartySkillsDir = fileURLToPath(new URL('../skills/', import.meta.url));
const activeDaemons = new Set<ChildProcess>();

const CHILD_SCRIPT = String.raw`
import { InkPiDaemon } from '@inkpi/server';

const skillDirectory = process.env.INKPI_PHASE12_SKILLS_DIR;
if (!skillDirectory) throw new Error('INKPI_PHASE12_SKILLS_DIR is required');

const daemon = new InkPiDaemon({
  host: '127.0.0.1',
  skillSearchDirs: [skillDirectory]
});

const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');

await daemon.start(0, '127.0.0.1');
await daemon.getTaskRouter().ready;
emit({ type: 'ready', port: daemon.getStatus().port });

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await daemon.stop();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
setInterval(() => undefined, 1_000);
`;

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function startDaemon(): Promise<RunningDaemon> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, INKPI_PHASE12_SKILLS_DIR: firstPartySkillsDir };
  for (const key of [
    'DEEPSEEK_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'GEMINI_API_KEY',
    'INKPI_MODEL_PRESET'
  ]) {
    delete childEnv[key];
  }

  const child = spawn(process.execPath, ['--input-type=module', '--eval', CHILD_SCRIPT], {
    cwd: repositoryRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  activeDaemons.add(child);

  return new Promise<RunningDaemon>((resolveDaemon, rejectDaemon) => {
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectDaemon(new Error(`Timed out waiting for child daemon; stderr=${stderrBuffer}; stdout=${stdoutBuffer}`));
    }, 15_000);
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const childFailure = (reason: string): Error =>
      new Error(`Child daemon ${reason}; stderr=${stderrBuffer}; stdout=${stdoutBuffer}`);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line) {
          try {
            const event = JSON.parse(line) as ChildEvent;
            if (event.type !== 'ready') {
              newlineIndex = stdoutBuffer.indexOf('\n');
              continue;
            }
            const port = event.port;
            if (typeof port !== 'number' || port <= 0) {
              finish(() => rejectDaemon(childFailure('reported an invalid TCP port')));
            } else {
              finish(() => resolveDaemon({ child, port }));
            }
          } catch {
            // Keep malformed output in the diagnostic buffer and wait for ready JSON.
          }
        }
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrBuffer += chunk;
    });
    child.once('error', (error) => finish(() => rejectDaemon(childFailure(`failed to spawn: ${error.message}`))));
    child.once('exit', (code, signal) => {
      if (!settled) finish(() => rejectDaemon(childFailure(`exited before ready (code=${code}, signal=${signal})`)));
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return new Promise<void>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      rejectExit(new Error('Timed out waiting for child daemon exit'));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit();
    };
    child.once('exit', onExit);
  });
}

async function stopDaemon(child: ChildProcess): Promise<void> {
  if (!hasExited(child)) {
    child.kill('SIGTERM');
    try {
      await waitForExit(child);
    } catch {
      if (!hasExited(child)) child.kill('SIGKILL');
      await waitForExit(child).catch(() => undefined);
    }
  }
  activeDaemons.delete(child);
}

afterEach(async () => {
  for (const child of [...activeDaemons]) await stopDaemon(child);
});

describe('Runtime Phase 12 cross-process skill contract', () => {
  it('keeps all first-party skills lazy-loadable and activates their instructions across daemon/client processes', async () => {
    const daemon = await startDaemon();
    const client = await InkRpcClient.connectTcp(daemon.port, '127.0.0.1');

    try {
      const discovered = await client.request<SkillManifest[]>('skill.discover');
      expect(discovered).toEqual(
        expect.arrayContaining([
          ...firstPartySkillIds.map((id) =>
            expect.objectContaining({ id, capabilities: firstPartySkillCapabilities[id] })
          )
        ])
      );
      expect(JSON.stringify(discovered)).not.toContain('Track each promise');

      const beforeLoad = await client.request<SkillRuntimeRegistrationSnapshot>('skill.status');
      expect(beforeLoad.loadedSkills).toEqual([]);
      expect(beforeLoad.activatedSkills).toEqual([]);
      expect(beforeLoad.instructions).toEqual([]);

      for (const skillId of firstPartySkillIds) {
        const loaded = await client.request<SkillLoadResult>('skill.load', { skillId });
        expect(loaded).toMatchObject({
          loaded: true,
          skill: { id: skillId, version: '1.0.0' }
        });
        expect(loaded.snapshot.loadedSkills).toContain(skillId);
        expect(JSON.stringify(loaded)).not.toContain('Track each promise');

        const activated = await client.request<SkillActivationResult>('skill.activate', { skillId });
        expect(activated).toMatchObject({
          activated: true,
          loaded: true,
          skill: { id: skillId, version: '1.0.0' }
        });
        expect(activated.snapshot.loadedSkills).toContain(skillId);
        expect(activated.snapshot.activatedSkills).toContain(skillId);
        const activatedInstruction = activated.snapshot.instructions?.find((entry) => entry.id === `skill.${skillId}`);
        expect(activatedInstruction).toBeDefined();
        expect(activatedInstruction).toMatchObject({
          id: `skill.${skillId}`,
          scope: 'skill',
          version: '1.0.0',
          source: `skill:${skillId}`,
          provenance: { skillId, skillVersion: '1.0.0' }
        });
      }

      const instructionStatus = await client.request<InstructionRegistryStatus>('instruction.status');
      expect(instructionStatus).toMatchObject({
        ready: true,
        version: `instructions-${firstPartySkillIds.length}`,
        count: firstPartySkillIds.length,
        instructionIds: firstPartySkillIds.map((skillId) => `skill.${skillId}`)
      });
      for (const skillId of firstPartySkillIds) {
        const statusInstruction = instructionStatus.instructions.find((entry) => entry.id === `skill.${skillId}`);
        expect(statusInstruction).toBeDefined();
        expect(statusInstruction).toMatchObject({
          id: `skill.${skillId}`,
          scope: 'skill',
          version: '1.0.0',
          source: `skill:${skillId}`,
          provenance: { skillId, skillVersion: '1.0.0' }
        });
      }
      expect(JSON.stringify(instructionStatus)).not.toContain('Track each promise');
    } finally {
      await client.close();
      await stopDaemon(daemon.child);
    }
  }, 30_000);
});
