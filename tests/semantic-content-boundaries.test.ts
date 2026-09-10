import { type SourceMapSegmentLike, evaluateSourceMapRanges } from '@inkpi/evals';
import { describe, expect, it } from 'vitest';

interface BlockFixture {
  blockId: string;
  text: string;
  editorFragment: string;
}

interface BlockSpan extends BlockFixture {
  semanticFrom: number;
  semanticTo: number;
  editorFrom: number;
  editorTo: number;
}

function buildProjectionFixture(blocks: readonly BlockFixture[]): {
  semanticText: string;
  editorText: string;
  segments: SourceMapSegmentLike[];
  spans: BlockSpan[];
} {
  let semanticOffset = 0;
  let editorOffset = 0;
  const segments: SourceMapSegmentLike[] = [];
  const spans: BlockSpan[] = [];

  for (const [index, block] of blocks.entries()) {
    const editorContentOffset = block.text ? block.editorFragment.indexOf(block.text) : 0;
    if (editorContentOffset < 0) {
      throw new Error(`Fixture text is not present in ${block.blockId}`);
    }

    const span: BlockSpan = {
      ...block,
      semanticFrom: semanticOffset,
      semanticTo: semanticOffset + block.text.length,
      editorFrom: editorOffset + editorContentOffset,
      editorTo: editorOffset + editorContentOffset + block.text.length
    };
    spans.push(span);
    segments.push({
      blockId: block.blockId,
      semanticFrom: span.semanticFrom,
      semanticTo: span.semanticTo,
      editorFrom: span.editorFrom,
      editorTo: span.editorTo
    });

    semanticOffset = span.semanticTo + (index < blocks.length - 1 ? 1 : 0);
    editorOffset += block.editorFragment.length;
  }

  return {
    semanticText: blocks.map((block) => block.text).join('\n'),
    editorText: blocks.map((block) => block.editorFragment).join(''),
    segments,
    spans
  };
}

describe('Phase 1 canonical content SourceMap boundary matrix', () => {
  it('keeps nested blocks, lists, code, empty nodes, Unicode, and duplicate text addressable', () => {
    const fixture = buildProjectionFixture([
      {
        blockId: 'heading:1',
        text: '复杂标题',
        editorFragment: '<h2>复杂标题</h2>'
      },
      {
        blockId: 'blockquote:1',
        text: '引用：重复 重复',
        editorFragment: '<blockquote><p>引用：重复 重复</p></blockquote>'
      },
      {
        blockId: 'list-item:1',
        text: '重复项',
        editorFragment: '<ul><li><strong>重复项</strong></li>'
      },
      {
        blockId: 'list-item:2',
        text: '重复项',
        editorFragment: '<li>重复项</li></ul>'
      },
      {
        blockId: 'code-block:1',
        text: 'const emoji = "😀";',
        editorFragment: '<pre><code>const emoji = "😀";</code></pre>'
      },
      {
        blockId: 'paragraph:empty',
        text: '',
        editorFragment: '<p></p>'
      }
    ]);

    const probes = fixture.spans.flatMap((span) => [
      { semantic: span.semanticFrom, expectedEditor: span.editorFrom },
      { semantic: span.semanticTo, expectedEditor: span.editorTo },
      { editor: span.editorFrom, expectedSemantic: span.semanticFrom },
      { editor: span.editorTo, expectedSemantic: span.semanticTo }
    ]);
    const codeSpan = fixture.spans[4]!;
    const emojiOffset = codeSpan.text.indexOf('😀');
    probes.push({
      semantic: codeSpan.semanticFrom + emojiOffset,
      expectedEditor: codeSpan.editorFrom + emojiOffset
    });

    const report = evaluateSourceMapRanges({
      semanticText: fixture.semanticText,
      editorText: fixture.editorText,
      segments: fixture.segments,
      ranges: [
        {
          editor: { from: fixture.spans[0]!.editorFrom, to: fixture.spans[1]!.editorTo },
          semantic: { from: fixture.spans[0]!.semanticFrom, to: fixture.spans[1]!.semanticTo }
        },
        {
          source: { from: codeSpan.editorFrom, to: codeSpan.editorTo },
          target: { from: codeSpan.semanticFrom, to: codeSpan.semanticTo }
        },
        {
          editor: { from: 0, to: fixture.editorText.length },
          semantic: { from: 0, to: fixture.semanticText.length }
        }
      ],
      probes,
      requireCoverage: false
    });

    expect(report.passed).toBe(true);
    expect(report.metrics).toMatchObject({
      segmentCount: 6,
      invalidSegmentCount: 0,
      rangeCount: 3,
      invalidRangeCount: 0
    });
    expect(fixture.spans[2]!.text).toBe(fixture.spans[3]!.text);
    expect(fixture.spans[2]!.semanticFrom).not.toBe(fixture.spans[3]!.semanticFrom);
    expect(fixture.spans[2]!.editorFrom).not.toBe(fixture.spans[3]!.editorFrom);
    expect(fixture.semanticText).toContain('😀');
    expect(fixture.semanticText.length).toBeGreaterThan([...fixture.semanticText].length);
  });

  it('accepts zero-length editor input and rejects out-of-bounds boundary probes', () => {
    const empty = evaluateSourceMapRanges({
      semanticText: '',
      editorText: '',
      segments: [],
      ranges: [{ editor: { from: 0, to: 0 }, semantic: { from: 0, to: 0 } }],
      requireCoverage: true
    });

    expect(empty.passed).toBe(true);
    expect(empty.metrics.coverageGapCount).toBe(0);

    const invalid = evaluateSourceMapRanges({
      semanticText: '边界',
      editorText: '边界',
      segments: [{ blockId: 'paragraph:1', semanticFrom: 0, semanticTo: 2, editorFrom: 0, editorTo: 2 }],
      ranges: [{ editor: { from: 0, to: 3 }, semantic: { from: 0, to: 2 } }],
      probes: [{ semantic: -1 }, { editor: Number.POSITIVE_INFINITY }],
      requireCoverage: true
    });

    expect(invalid.passed).toBe(false);
    expect(invalid.metrics.invalidRangeCount).toBe(1);
    expect(invalid.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining(['range-out-of-bounds', 'source-map-probe-out-of-bounds'])
    );
  });

  it('fails required coverage when an internal semantic or editor hole is present', () => {
    const report = evaluateSourceMapRanges({
      semanticText: 'abcdef',
      editorText: 'uvwxyz',
      segments: [
        { blockId: 'first', semanticFrom: 0, semanticTo: 2, editorFrom: 0, editorTo: 2 },
        { blockId: 'last', semanticFrom: 3, semanticTo: 6, editorFrom: 3, editorTo: 6 }
      ],
      requireCoverage: true
    });

    expect(report.passed).toBe(false);
    expect(report.metrics.coverageGapCount).toBe(2);
    expect(report.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining(['source-map-semantic-gap', 'source-map-editor-gap'])
    );
  });
});
