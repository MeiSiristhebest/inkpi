import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(new URL('../scripts/phase18-input.mjs', import.meta.url));

function utf8Corpus(count: number): string {
  return Array.from({ length: count }, (_, index) => {
    const chapter = index + 1;
    return `第${chapter}章 标题 ${chapter}\r\n正文 ${chapter}`;
  }).join('\r\n\r\n');
}

function gb18030Corpus(count: number): Buffer {
  const chapterPrefix = Buffer.from([0xb5, 0xda]);
  const chapterSuffix = Buffer.from([0xd5, 0xc2]);
  const body = Buffer.from([0xd5, 0xfd, 0xce, 0xc4]);
  const sections = Array.from({ length: count }, (_, index) =>
    Buffer.concat([
      chapterPrefix,
      Buffer.from(String(index + 1), 'ascii'),
      chapterSuffix,
      Buffer.from(` title ${index + 1}\r\n`, 'ascii'),
      body,
      Buffer.from(` ${index + 1}`, 'ascii')
    ])
  );
  return Buffer.concat(sections.map((section) => Buffer.concat([section, Buffer.from('\r\n\r\n', 'ascii')])));
}

function writeInputs(input100: Uint8Array | string, input300: Uint8Array | string) {
  const directory = mkdtempSync(join(tmpdir(), 'inkpi-phase18-input-'));
  const path100 = join(directory, 'book-100.txt');
  const path300 = join(directory, 'book-300.txt');
  writeFileSync(path100, input100);
  writeFileSync(path300, input300);
  return { path100, path300 };
}

describe('Phase 18 corpus input assembler', () => {
  it('detects UTF-8 and GB18030 and emits both real-provider benchmark chapter arrays', () => {
    const { path100, path300 } = writeInputs(gb18030Corpus(100), utf8Corpus(300));
    const result = spawnSync(process.execPath, [scriptPath, '--input-100', path100, '--input-300', path300], {
      encoding: 'utf8'
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('100 chapters; encoding=gb18030');
    expect(result.stderr).toContain('300 chapters; encoding=utf-8');
    const template = JSON.parse(result.stdout) as {
      id: string;
      mode: string;
      benchmarks: Array<{
        id: string;
        mode: string;
        chapterCount: number;
        chapters: Array<{ chapter: number; text: string }>;
        responseContract: {
          expectedRetrievedAnchors: number[];
          expectedRecoveredChapter: number;
        };
      }>;
      [key: string]: unknown;
    };
    expect(template).toMatchObject({ id: 'phase18-real-provider-input-template', mode: 'real-provider' });
    expect(template.benchmarks.map(({ chapterCount }) => chapterCount)).toEqual([100, 300]);
    expect(template.benchmarks[0]?.chapters).toHaveLength(100);
    expect(template.benchmarks[1]?.chapters).toHaveLength(300);
    expect(template.benchmarks[0]?.chapters[0]).toMatchObject({
      chapter: 1,
      text: expect.stringContaining('第1章')
    });
    expect(template.benchmarks[0]?.chapters[0]?.text).toContain('正文 1');
    expect(template.benchmarks[1]?.chapters[299]).toMatchObject({ chapter: 300 });
    expect(template.benchmarks.map(({ responseContract }) => responseContract)).toEqual([
      { expectedRetrievedAnchors: [1, 50, 100], expectedRecoveredChapter: 100 },
      { expectedRetrievedAnchors: [1, 150, 300], expectedRecoveredChapter: 300 }
    ]);
  });

  it('supports Chinese chapter numerals and keeps the heading in the chapter text', () => {
    const { path100, path300 } = writeInputs(
      ['第一章 开始', '第二章 继续', ...Array.from({ length: 98 }, (_, index) => `第${index + 3}章 内容`)].join('\n'),
      utf8Corpus(300)
    );
    const result = spawnSync(process.execPath, [scriptPath, '--input-100', path100, '--input-300', path300], {
      encoding: 'utf8'
    });

    expect(result.status).toBe(0);
    const template = JSON.parse(result.stdout) as {
      benchmarks: Array<{ chapters: Array<{ chapter: number; text: string }> }>;
    };
    expect(template.benchmarks[0]?.chapters.slice(0, 2)).toEqual([
      { chapter: 1, text: '第一章 开始' },
      { chapter: 2, text: '第二章 继续' }
    ]);
  });

  it('rejects a corpus with a missing or extra chapter instead of filling it', () => {
    const { path100, path300 } = writeInputs(utf8Corpus(99), utf8Corpus(300));
    const result = spawnSync(process.execPath, [scriptPath, '--input-100', path100, '--input-300', path300], {
      encoding: 'utf8'
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('expected 100 chapters, found 99');
  });

  it('does not add labels, provider results, or runtime observations to the template', () => {
    const { path100, path300 } = writeInputs(utf8Corpus(100), utf8Corpus(300));
    const outputPath = join(mkdtempSync(join(tmpdir(), 'inkpi-phase18-output-')), 'template.json');
    execFileSync(
      process.execPath,
      [scriptPath, '--input-100', path100, '--input-300', path300, '--output', outputPath],
      {
        encoding: 'utf8'
      }
    );

    const template = JSON.parse(readFileSync(outputPath, 'utf8')) as Record<string, unknown>;
    expect(template).not.toHaveProperty('attestation');
    expect(template).not.toHaveProperty('objectiveAssertions');
    expect(template).not.toHaveProperty('mutationTests');
    expect(template).not.toHaveProperty('goldSet');
    expect(template).not.toHaveProperty('pairwise');
    expect(JSON.stringify(template)).not.toContain('observations');
    expect(JSON.stringify(template)).not.toContain('providerResult');
  });
});
