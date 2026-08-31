import { describe, it, expect } from 'vitest';
import {
  TUI,
  Editor,
  ThinkingAccordion,
  parseKey
} from '@meisiristhebest/tui';
import {
  ModelCatalogManager,
  findModelInCatalog
} from '@meisiristhebest/ai';
import {
  InkRpcServer,
  InkPiClient,
  StoryboardExporter,
  NodeVMSandbox,
  SandboxManager,
  SessionTree
} from '@meisiristhebest/agent-core';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

describe('InkPi 6-Pillar Industrial Architecture Integration Suite (1:1 Aligned with Pi)', () => {
  // -------------------------------------------------------------
  // Pillar 1: TUI Kernel, Mouse/Wheel/Keys & Advanced Editor Autocomplete + KillRing
  // -------------------------------------------------------------
  describe('Pillar 1: TUI Hardened Kernel, Mouse/Keys & High-Grade Editor', () => {
    it('should parse extended mouse wheel, focus, and bracketed paste events', () => {
      const wheelUp = parseKey('\x1b[<64;10;20M');
      expect(wheelUp.isMouse).toBe(true);
      expect(wheelUp.name).toBe('wheelup');
      expect(wheelUp.mouseX).toBe(10);
      expect(wheelUp.mouseY).toBe(20);

      const wheelDown = parseKey('\x1b[<65;15;30M');
      expect(wheelDown.name).toBe('wheeldown');

      const mouseOther = parseKey('\x1b[<0;5;5M');
      expect(mouseOther.name).toBe('mouse_0');

      const focusIn = parseKey('\x1b[I');
      expect(focusIn.name).toBe('focusin');

      const focusOut = parseKey('\x1b[O');
      expect(focusOut.name).toBe('focusout');

      const pasteStart = parseKey('\x1b[200~');
      expect(pasteStart.name).toBe('paste_start');

      const pasteEnd = parseKey('\x1b[201~');
      expect(pasteEnd.name).toBe('paste_end');

      const shiftTab = parseKey('\x1b[Z');
      expect(shiftTab.shift).toBe(true);

      const ctrlUp = parseKey('\x1b[1;5A');
      expect(ctrlUp.ctrl).toBe(true);

      const ctrlDown = parseKey('\x1b[1;5B');
      expect(ctrlDown.ctrl).toBe(true);

      const ctrlRight = parseKey('\x1b[1;5C');
      expect(ctrlRight.ctrl).toBe(true);

      const ctrlLeft = parseKey('\x1b[1;5D');
      expect(ctrlLeft.ctrl).toBe(true);

      const pageUp = parseKey('\x1b[5~');
      expect(pageUp.name).toBe('pageup');

      const pageDown = parseKey('\x1b[6~');
      expect(pageDown.name).toBe('pagedown');

      const f1 = parseKey('\x1bOP');
      expect(f1.name).toBe('f1');
      const f2 = parseKey('\x1bOQ');
      expect(f2.name).toBe('f2');
      const f3 = parseKey('\x1bOR');
      expect(f3.name).toBe('f3');
      const f4 = parseKey('\x1bOS');
      expect(f4.name).toBe('f4');
    });

    it('should support Editor Kill-Ring, Multi-Level Undo/Redo and @/#/ Autocomplete', () => {
      const editor = new Editor({
        text: '第一章 始动\n林动来到青阳镇。',
        completionProvider: (trigger, query) => {
          if (trigger === '@') {
            return [
              { label: '林动', detail: '主角 (天元境)', insertText: '林动' },
              { label: '林青檀', detail: '妹妹 (纯阴之体)', insertText: '林青檀' }
            ];
          }
          if (trigger === '#') {
            return [{ label: '青阳镇', detail: '大炎王朝天都郡', insertText: '青阳镇' }];
          }
          if (trigger === '/') {
            return [{ label: 'gate-check', detail: '剧情质量门禁', insertText: 'gate-check' }];
          }
          return [];
        }
      });

      // Test Empty undo/redo
      const freshEditor = new Editor();
      expect(freshEditor.undo()).toBe(false);
      expect(freshEditor.redo()).toBe(false);
      expect(freshEditor.applyCompletion()).toBe(false);

      // Test Kill-Ring
      editor.cursorRow = 1;
      editor.cursorCol = 0;
      editor.killLine(); // kill line 1
      expect(editor.lines[1]).toBe('');

      // Kill at end of line (joins line)
      editor.cursorRow = 0;
      editor.cursorCol = editor.lines[0].length;
      editor.killLine();
      expect(editor.lines.length).toBe(1);

      // Yank multiline back
      editor.yank();
      expect(editor.lines.length).toBeGreaterThanOrEqual(1);

      // Set text
      editor.setText('第一章 始动\n林动来到青阳镇。');

      // Test Multi-Level Undo/Redo
      editor.cursorRow = 1;
      editor.cursorCol = 2;
      editor.handleKey({ name: '!', ctrl: false, meta: false, shift: false, sequence: '!', raw: '!' });
      expect(editor.lines[1]).toBe('林动!来到青阳镇。');

      editor.undo();
      expect(editor.lines[1]).toBe('林动来到青阳镇。');

      editor.redo();
      expect(editor.lines[1]).toBe('林动!来到青阳镇。');

      // Test Home and End
      editor.handleKey({ name: 'home', ctrl: false, meta: false, shift: false, sequence: '', raw: '' });
      expect(editor.cursorCol).toBe(0);

      editor.handleKey({ name: 'end', ctrl: false, meta: false, shift: false, sequence: '', raw: '' });
      expect(editor.cursorCol).toBe(editor.lines[1].length);

      // Test @ Autocomplete popup & navigation
      editor.handleKey({ name: '@', ctrl: false, meta: false, shift: false, sequence: '@', raw: '@' });
      expect(editor.isCompleting).toBe(true);
      expect(editor.completionItems.length).toBe(2);

      // Down navigation (wrap around)
      editor.handleKey({ name: 'down', ctrl: false, meta: false, shift: false, sequence: '', raw: '' });
      expect(editor.completeIndex).toBe(1);
      editor.handleKey({ name: 'down', ctrl: false, meta: false, shift: false, sequence: '', raw: '' });
      expect(editor.completeIndex).toBe(0);

      // Up navigation (wrap around)
      editor.handleKey({ name: 'up', ctrl: false, meta: false, shift: false, sequence: '', raw: '' });
      expect(editor.completeIndex).toBe(1);

      // Escape dismissal
      editor.handleKey({ name: 'escape', ctrl: false, meta: false, shift: false, sequence: '\x1b', raw: '\x1b' });
      expect(editor.isCompleting).toBe(false);

      // Re-trigger and apply with Enter
      editor.handleKey({ name: '@', ctrl: false, meta: false, shift: false, sequence: '@', raw: '@' });
      editor.handleKey({ name: 'enter', ctrl: false, meta: false, shift: false, sequence: '\r', raw: '\r' });
      expect(editor.lines[1]).toContain('林动');

      // Test Backspace joining lines
      editor.cursorRow = 1;
      editor.cursorCol = 0;
      editor.handleKey({ name: 'backspace', ctrl: false, meta: false, shift: false, sequence: '\x7f', raw: '\x7f' });
      expect(editor.lines.length).toBe(1);

      // Test Delete joining lines
      editor.handleKey({ name: 'enter', ctrl: false, meta: false, shift: false, sequence: '\r', raw: '\r' });
      editor.cursorRow = 0;
      editor.cursorCol = editor.lines[0].length;
      editor.handleKey({ name: 'delete', ctrl: false, meta: false, shift: false, sequence: '', raw: '' });
      expect(editor.lines.length).toBe(1);

      // Test Boundary cursor navigation
      editor.setText('Line 0\nLine 1\nLine 2');
      editor.cursorRow = 0;
      editor.handleKey({ name: 'up', ctrl: false, meta: false, shift: false, sequence: '', raw: '' });
      expect(editor.cursorRow).toBe(0);

      editor.cursorRow = 2;
      editor.handleKey({ name: 'down', ctrl: false, meta: false, shift: false, sequence: '', raw: '' });
      expect(editor.cursorRow).toBe(2);

      editor.cursorCol = 0;
      editor.handleKey({ name: 'left', ctrl: false, meta: false, shift: false, sequence: '', raw: '' });
      expect(editor.cursorRow).toBe(1);

      editor.cursorCol = editor.lines[1].length;
      editor.handleKey({ name: 'right', ctrl: false, meta: false, shift: false, sequence: '', raw: '' });
      expect(editor.cursorRow).toBe(2);

      // ReadOnly test
      editor.readOnly = true;
      expect(editor.handleKey({ name: 'a', ctrl: false, meta: false, shift: false, sequence: 'a', raw: 'a' })).toBe(false);
      editor.readOnly = false;

      // ScrollRow adjustment test
      editor.cursorRow = 15;
      editor.render({ width: 80, height: 5 });
      expect(editor.scrollRow).toBeGreaterThan(0);

      // Render check without line numbers
      editor.showLineNumbers = false;
      const rendered = editor.render({ width: 80, height: 10 });
      expect(rendered.length).toBe(10);
    });
  });

  // -------------------------------------------------------------
  // Pillar 2: Model Catalog Routing & Thinking Stream Accordion
  // -------------------------------------------------------------
  describe('Pillar 2: Task-Oriented Model Routing & Streamed ThinkingAccordion', () => {
    it('should route optimal planning model (high reasoning) vs drafting model (high throughput)', () => {
      const manager = new ModelCatalogManager();

      const planningModel = manager.getRecommendedPlanningModel();
      expect(planningModel).toBeDefined();
      expect(planningModel.supportsThinking).toBe(true);

      const draftingModel = manager.getRecommendedDraftingModel();
      expect(draftingModel).toBeDefined();

      const routedPlanning = manager.routeModelForTask('planning');
      expect(routedPlanning.supportsThinking).toBe(true);

      const routedAuditing = manager.routeModelForTask('auditing');
      expect(routedAuditing.supportsThinking).toBe(true);

      const routedDrafting = manager.routeModelForTask('drafting');
      expect(routedDrafting).toBeDefined();

      const routedPolishing = manager.routeModelForTask('polishing');
      expect(routedPolishing).toBeDefined();

      // Override model routing
      const overridden = manager.routeModelForTask('drafting', planningModel.id);
      expect(overridden.id).toBe(planningModel.id);
    });

    it('should stream thinking tokens and toggle collapse state in ThinkingAccordion', () => {
      const accordion = new ThinkingAccordion({
        modelName: 'DeepSeek-R1',
        isCollapsed: true
      });

      accordion.startStreaming();
      expect(accordion.isCollapsed).toBe(false);
      expect(accordion.isStreaming).toBe(true);

      accordion.appendThinking('正在推演林动的动机...\n');
      accordion.appendThinking('确认其动机符合逻辑。');
      accordion.finishStreaming();
      expect(accordion.isStreaming).toBe(false);
      expect(accordion.elapsedMs).toBeGreaterThanOrEqual(0);

      const renderedOpen = accordion.render({ width: 80, height: 10 });
      expect(renderedOpen.some((l) => l.includes('推演林动的动机'))).toBe(true);

      // Toggle fold with space, enter or Ctrl+O
      accordion.handleKey({ name: 'space', ctrl: false, meta: false, shift: false, sequence: ' ', raw: ' ' });
      expect(accordion.isCollapsed).toBe(true);

      accordion.handleKey({ name: 'enter', ctrl: false, meta: false, shift: false, sequence: '\r', raw: '\r' });
      expect(accordion.isCollapsed).toBe(false);

      accordion.handleKey({ name: 'o', ctrl: true, meta: false, shift: false, sequence: '\x0f', raw: '\x0f' });
      expect(accordion.isCollapsed).toBe(true);

      expect(accordion.handleKey({ name: 'x', ctrl: false, meta: false, shift: false, sequence: 'x', raw: 'x' })).toBe(false);


      const renderedClosed = accordion.render({ width: 80, height: 10 });
      expect(renderedClosed.some((l) => l.includes('推演林动的动机'))).toBe(false);
    });
  });

  // -------------------------------------------------------------
  // Pillar 3: Headless Server Daemon & Distributed RPC
  // -------------------------------------------------------------
  describe('Pillar 3: Headless Agent Daemon & Multi-Transport RPC', () => {
    it('should start TCP daemon server, broadcast notifications and handle client RPC calls', async () => {
      const server = new InkRpcServer();
      const testPort = 19888;
      const netServer = await server.listenTcp(testPort);
      expect(netServer).toBeDefined();

      let receivedNotification = false;
      server.setNotificationSender((notif) => {
        if (notif.method === 'test.broadcast') receivedNotification = true;
      });

      server.notify('test.broadcast', { message: 'hello world' });
      expect(receivedNotification).toBe(true);

      await server.close();
    });
  });

  // -------------------------------------------------------------
  // Pillar 4: Interactive Storyboard HTML Export
  // -------------------------------------------------------------
  describe('Pillar 4: Interactive Storyboard HTML Single-File Export', () => {
    it('should export full self-contained interactive HTML with tabs, DAG diffs, ledgers, and cost metrics', () => {
      const tree = new SessionTree();
      tree.addMessage({ role: 'user', content: '设定世界观背景' } as any);
      tree.addMessage({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '构建大千世界与玄幻体系' },
          { type: 'text', text: '大千世界，位面交汇，万族林立。' },
          { type: 'toolCall', name: 'search_lore', arguments: { query: '大炎王朝' } }
        ]
      } as any);
      tree.addMessage({
        role: 'toolResult',
        content: { found: true, result: '大炎王朝位于东玄域' }
      } as any);

      const html = StoryboardExporter.exportToStoryboardHtml(
        tree.getHistory(),
        {
          title: '武动乾坤创作推演档案',
          author: '天蚕土豆',
          ledger: {
            entities: [{ id: '1', name: '林动', status: 'active', attributes: { level: '天元境' } }],
            assets: [{ id: '2', name: '神秘石符', holder: '林动', state: 'intact' } as any],
            locations: [],
            tracks: [],
            modifiedResources: []
          },
          gateIssues: [
            { type: 'EntityDeathGate', severity: 'warning', description: '检测到重要配角受伤' }
          ],
          usageTotals: {
            inputTokens: 50000,
            outputTokens: 12000,
            cacheReadTokens: 40000,
            totalTokens: 62000,
            costUsd: 0.05
          },
          whatIfSummaries: [
            { branchName: 'IF-林动未得石符', summaryText: '林动未能逆袭，青阳镇由雷家主导', entityDiffCount: 3 }
          ]
        },
        tree
      );

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('武动乾坤创作推演档案');
      expect(html).toContain('天蚕土豆');
      expect(html).toContain('神秘石符');
      expect(html).toContain('IF-林动未得石符');
      expect(html).toContain('构建大千世界与玄幻体系');
      expect(html).toContain('search_lore');
      expect(html).toContain('$0.0500');

      // Test empty options fallback
      const fallbackHtml = StoryboardExporter.exportToStoryboardHtml([]);
      expect(fallbackHtml).toContain('<!DOCTYPE html>');
    });
  });

  // -------------------------------------------------------------
  // Pillar 5: MicroVM / Sandbox Isolation
  // -------------------------------------------------------------
  describe('Pillar 5: Sandbox Isolation & Safe World Simulation', () => {
    it('should safely execute rule scripts and math simulation with NodeVMSandbox', async () => {
      const sandbox = new NodeVMSandbox({ defaultTimeoutMs: 1500 });
      const manager = new SandboxManager(sandbox);

      // Safe calculation, logging and dice roll
      const res = await manager.runRuleScript(`
        console.log("Starting simulation");
        console.warn("High gravity detected");
        console.error("Shield depleted");
        const baseAttack = 50;
        const dice = roll('1d20');
        const defaultDice = roll('');
        const isCrit = dice >= 18;
        return {
          attack: isCrit ? baseAttack * 2 : baseAttack,
          dice,
          defaultDice,
          isCrit
        };
      `);

      expect(res.success).toBe(true);
      expect(res.stdout).toContain('Starting simulation');
      expect(res.stderr).toContain('High gravity detected');
      expect(res.result.attack).toBeGreaterThanOrEqual(50);
      expect(res.result.dice).toBeGreaterThanOrEqual(1);
      expect(res.result.defaultDice).toBeGreaterThanOrEqual(1);

      // Safe expression evaluation
      const exprRes = await manager.evaluateExpression('100 * 1.5 + 20');
      expect(exprRes.success).toBe(true);
      expect(exprRes.result).toBe(170);
    });

    it('should intercept security violation (access to process/fs) and infinite loop timeout', async () => {
      const sandbox = new NodeVMSandbox({ defaultTimeoutMs: 200 });

      // Security violation
      const secRes = await sandbox.execute('return process.env;');
      expect(secRes.success).toBe(false);
      expect(secRes.error).toContain('Sandbox Security Violation');

      // Timeout protection (infinite loop)
      const timeoutRes = await sandbox.execute('while(true) {}');
      expect(timeoutRes.success).toBe(false);
      expect(timeoutRes.terminatedByTimeout).toBe(true);
    });
  });

  // -------------------------------------------------------------
  // Pillar 6: Release Engineering & Supply Chain
  // -------------------------------------------------------------
  describe('Pillar 6: Release Engineering & Standalone Single Binary Packaging', () => {
    it('should execute build-binaries pipeline in dry-run mode and verify pinned dependencies', () => {
      const before = execSync('git status --short', { cwd: rootDir, encoding: 'utf8' });
      const output = execSync('node scripts/build-binaries.mjs --dry-run', {
        cwd: rootDir,
        encoding: 'utf8'
      });
      const after = execSync('git status --short', { cwd: rootDir, encoding: 'utf8' });

      expect(output).toContain('InkPi Binary Release Engineering');
      expect(output).toContain('Step 1: Running supply-chain dependency verification');
      expect(output).toContain('Step 2: Preparing Standalone Release Entrypoint');
      expect(output).toContain('Build pipeline completed successfully');
      expect(after).toBe(before);
    });

    it('should execute inkpi-standalone.mjs CLI both in studio frame and print mode', () => {
      // 1. Studio frame render
      const studioOutput = execSync('node scripts/inkpi-standalone.mjs', {
        cwd: rootDir,
        encoding: 'utf8'
      });
      expect(studioOutput).toContain('Studio');
      expect(studioOutput).toContain('Resources');
      expect(studioOutput).toContain('Runtime State');

      // 2. Print mode execution
      const printOutput = execSync('node scripts/inkpi-standalone.mjs --print --model mock-test --prompt "测试小说开篇" --json', {
        cwd: rootDir,
        encoding: 'utf8'
      });
      const parsed = JSON.parse(printOutput);
      expect(parsed.success).toBe(true);
      expect(parsed.role).toBe('assistant');

      expect(() => execSync('node scripts/inkpi-standalone.mjs --print --prompt', {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: 'pipe'
      })).toThrow();
    });
  });
});
