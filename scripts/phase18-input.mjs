#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED_CHAPTER_COUNTS = new Set([100, 300]);
const CHINESE_CHAPTER_DIGITS = '零〇一二三四五六七八九十百千万亿两';
const CHAPTER_HEADING = new RegExp(
  `^[ \\t]*第[ \\t]*([0-9０-９${CHINESE_CHAPTER_DIGITS}]+)[ \\t]*章(?:[ \\t]*(.*))?$`,
  'gm'
);

/**
 * Decode an external corpus without silently replacing malformed bytes.
 * UTF-8 is preferred when both decoders accept the bytes; that is the only
 * undecidable case for ASCII-only input.
 */
export function decodeExternalText(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('The corpus must be supplied as bytes.');
  }

  const hasUtf8Bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (hasUtf8Bom) {
    try {
      return { encoding: 'utf-8', text: stripBom(decodeStrict(bytes, 'utf-8')) };
    } catch {
      throw new Error('The corpus has a UTF-8 BOM but is not valid UTF-8.');
    }
  }

  try {
    return { encoding: 'utf-8', text: stripBom(decodeStrict(bytes, 'utf-8')) };
  } catch {
    try {
      return { encoding: 'gb18030', text: stripBom(decodeStrict(bytes, 'gb18030')) };
    } catch {
      throw new Error('The corpus is neither valid UTF-8 nor valid GB18030.');
    }
  }
}

function decodeStrict(bytes, encoding) {
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  if (text.includes('\ufffd')) throw new Error(`Invalid ${encoding} replacement character.`);
  return text;
}

function stripBom(text) {
  return text.startsWith('\ufeff') ? text.slice(1) : text;
}

/** Convert the numeric part of a chapter heading to an integer. */
export function parseChapterNumber(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('A chapter heading has no number.');
  }

  const ascii = value.replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xff10));
  if (/^\d+$/.test(ascii)) {
    const number = Number(ascii);
    if (Number.isSafeInteger(number) && number > 0) return number;
  }

  const digits = new Map([
    ['零', 0],
    ['〇', 0],
    ['一', 1],
    ['二', 2],
    ['两', 2],
    ['三', 3],
    ['四', 4],
    ['五', 5],
    ['六', 6],
    ['七', 7],
    ['八', 8],
    ['九', 9]
  ]);
  const units = new Map([
    ['十', 10],
    ['百', 100],
    ['千', 1000],
    ['万', 10_000],
    ['亿', 100_000_000]
  ]);
  if (![...ascii].every((character) => digits.has(character) || units.has(character))) {
    throw new Error(`Unsupported chapter number: ${value}`);
  }

  if (![...ascii].some((character) => units.has(character))) {
    const number = Number([...ascii].map((character) => digits.get(character)).join(''));
    if (Number.isSafeInteger(number) && number > 0) return number;
  }

  let total = 0;
  let section = 0;
  let current = 0;
  for (const character of ascii) {
    const digit = digits.get(character);
    if (digit !== undefined) {
      current = digit;
      continue;
    }

    const unit = units.get(character);
    if (unit === undefined) throw new Error(`Unsupported chapter number: ${value}`);
    if (unit >= 10_000) {
      section += current;
      total += section * unit;
      section = 0;
    } else {
      section += (current || 1) * unit;
    }
    current = 0;
  }

  const number = total + section + current;
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Invalid chapter number: ${value}`);
  return number;
}

/**
 * Split normalized chapter sections. The heading stays in `text` so the
 * conversion does not discard source material; line endings are normalized.
 */
export function splitChapterText(sourceText, sourceName = 'input') {
  if (typeof sourceText !== 'string') throw new TypeError('The corpus text must be a string.');
  const text = stripBom(sourceText).replace(/\r\n?/g, '\n');
  const matches = [...text.matchAll(new RegExp(CHAPTER_HEADING.source, CHAPTER_HEADING.flags))];
  if (matches.length === 0) throw new Error(`${sourceName}: no "第N章" headings were found.`);

  const chapters = [];
  const seen = new Set();
  for (const [index, match] of matches.entries()) {
    const chapter = parseChapterNumber(match[1]);
    if (seen.has(chapter)) throw new Error(`${sourceName}: duplicate chapter ${chapter}.`);
    const expected = index + 1;
    if (chapter !== expected) {
      throw new Error(`${sourceName}: expected chapter ${expected}, found chapter ${chapter}.`);
    }
    seen.add(chapter);

    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? text.length;
    const section = text.slice(start, end).trim();
    if (section.length === 0) throw new Error(`${sourceName}: chapter ${chapter} is empty.`);
    chapters.push({ chapter, text: section });
  }
  return chapters;
}

export function readExternalChapterCorpus(filePath, expectedChapterCount) {
  if (!ALLOWED_CHAPTER_COUNTS.has(expectedChapterCount)) {
    throw new Error(`Expected chapter count must be 100 or 300, got ${expectedChapterCount}.`);
  }
  const decoded = decodeExternalText(readFileSync(filePath));
  const chapters = splitChapterText(decoded.text, filePath);
  if (chapters.length !== expectedChapterCount) {
    throw new Error(`${filePath}: expected ${expectedChapterCount} chapters, found ${chapters.length}.`);
  }
  return { filePath, encoding: decoded.encoding, chapterCount: chapters.length, chapters };
}

/**
 * Create the smallest Phase 18-shaped envelope that can carry the corpus.
 * Evidence fields are intentionally absent and must be supplied externally.
 */
export function createPhase18InputTemplate(corpora) {
  if (!Array.isArray(corpora) || corpora.length !== 2) {
    throw new Error('Provide exactly one 100-chapter corpus and one 300-chapter corpus.');
  }

  const byCount = new Map();
  for (const corpus of corpora) {
    if (!corpus || !ALLOWED_CHAPTER_COUNTS.has(corpus.chapterCount)) {
      throw new Error('Each corpus must contain exactly 100 or 300 chapters.');
    }
    if (byCount.has(corpus.chapterCount)) {
      throw new Error(`Duplicate ${corpus.chapterCount}-chapter corpus.`);
    }
    if (!Array.isArray(corpus.chapters) || corpus.chapters.length !== corpus.chapterCount) {
      throw new Error(`Corpus ${corpus.chapterCount} has an inconsistent chapter array.`);
    }
    byCount.set(corpus.chapterCount, corpus);
  }

  return {
    id: 'phase18-real-provider-input-template',
    mode: 'real-provider',
    benchmarks: [100, 300].map((chapterCount) => {
      const corpus = byCount.get(chapterCount);
      if (!corpus) throw new Error(`Missing ${chapterCount}-chapter corpus.`);
      return {
        id: `external-long-context-${chapterCount}`,
        mode: 'real-provider',
        chapterCount,
        chapters: corpus.chapters.map(({ chapter, text }) => ({ chapter, text }))
      };
    })
  };
}

function parseArgs(argv) {
  const options = { input100: undefined, input300: undefined, output: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    const next = argv[index + 1];
    if (argument === '--input-100') {
      if (!next) throw new Error('--input-100 requires a path.');
      options.input100 = next;
      index += 1;
      continue;
    }
    if (argument === '--input-300') {
      if (!next) throw new Error('--input-300 requires a path.');
      options.input300 = next;
      index += 1;
      continue;
    }
    if (argument === '--output') {
      if (!next) throw new Error('--output requires a path.');
      options.output = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: node scripts/phase18-input.mjs --input-100 <file> --input-300 <file> [--output <file>]',
      '',
      'Reads UTF-8 or GB18030 TXT files, splits lines headed by 第N章, and emits a Phase 18 input template.',
      'The template contains only corpus benchmarks. Add attestation, objective/mutation evidence, human labels,',
      'pairwise evidence, benchmark expectations, and runtime observations through the external evidence process.',
      'This command never calls a provider and never reads API-key environment variables.'
    ].join('\n') + '\n'
  );
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      printHelp();
      return 0;
    }
    if (!options.input100 || !options.input300) {
      throw new Error('Both --input-100 and --input-300 are required. Use --help for usage.');
    }

    const corpora = [
      readExternalChapterCorpus(options.input100, 100),
      readExternalChapterCorpus(options.input300, 300)
    ];
    const serialized = `${JSON.stringify(createPhase18InputTemplate(corpora), null, 2)}\n`;
    if (options.output) {
      writeFileSync(options.output, serialized, { encoding: 'utf8' });
    } else {
      process.stdout.write(serialized);
    }
    for (const corpus of corpora) {
      process.stderr.write(`phase18-input: ${corpus.chapterCount} chapters; encoding=${corpus.encoding}\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`phase18-input: ${message}\n`);
    return 1;
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entryPath === fileURLToPath(import.meta.url)) process.exitCode = main();
