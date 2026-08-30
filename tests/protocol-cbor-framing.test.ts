import { describe, it, expect } from 'vitest';
import {
  encodeCbor,
  decodeCbor,
  encodeFrame,
  FrameDecoder,
  encodeProtocolPayload,
  decodeProtocolPayload,
  StreamPayloadDecoder,
  CborError
} from '../packages/protocol/src/index.js';

describe('Protocol CBOR & Framing Suite (Aligned with Pi)', () => {
  it('should encode and decode primitive types and complex nested structures correctly', () => {
    const complexData = {
      novelTitle: '修仙万界录',
      chapter: 42,
      wordCount: 12500,
      isFinished: false,
      rating: 9.85,
      characters: ['林玄', '萧寒', '柳青衣'],
      metadata: {
        foreshadowing: { clue: '神秘玉佩', resolved: false },
        tags: ['玄幻', '升级', '热血']
      },
      nilValue: null
    };

    const encoded = encodeCbor(complexData);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.byteLength).toBeGreaterThan(0);

    const decoded = decodeCbor(encoded) as typeof complexData;
    expect(decoded).toEqual(complexData);
  });

  it('should support binary byte strings (Uint8Array)', () => {
    const rawBuffer = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
    const payload = { imageBytes: rawBuffer };

    const encoded = encodeCbor(payload);
    const decoded = decodeCbor(encoded) as { imageBytes: Uint8Array };

    expect(decoded.imageBytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded.imageBytes)).toEqual(Array.from(rawBuffer));
  });

  it('should frame payloads with 4-byte length prefix and decode complete frames', () => {
    const data = { action: 'branch_switch', target: 'what-if-timeline-2' };
    const framed = encodeProtocolPayload(data);

    expect(framed.byteLength).toBeGreaterThan(4);
    const decoded = decodeProtocolPayload(framed);
    expect(decoded).toEqual(data);
  });

  it('should handle fragmented streaming chunks using FrameDecoder', () => {
    const messages = [
      { id: 1, text: '第一章 苍穹破晓' },
      { id: 2, text: '第二章 剑起风云' },
      { id: 3, text: '第三章 仙宗来客' }
    ];

    const streamDecoder = new StreamPayloadDecoder();
    const allFrames: Uint8Array[] = [];

    for (const msg of messages) {
      allFrames.push(encodeProtocolPayload(msg));
    }

    // Combine all frames into one buffer
    const totalLength = allFrames.reduce((acc, f) => acc + f.byteLength, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const f of allFrames) {
      combined.set(f, offset);
      offset += f.byteLength;
    }

    // Slice combined into small arbitrary 7-byte chunks to simulate network packet fragmentation
    const decodedList: any[] = [];
    const chunkSize = 7;
    for (let i = 0; i < combined.byteLength; i += chunkSize) {
      const chunk = combined.subarray(i, Math.min(combined.byteLength, i + chunkSize));
      const items = streamDecoder.push(chunk);
      decodedList.push(...items);
    }
    streamDecoder.end();

    expect(decodedList).toHaveLength(3);
    expect(decodedList).toEqual(messages);
  });

  it('should throw CborError when exceeding max depth or limits', () => {
    let deeplyNested: any = 'leaf';
    for (let i = 0; i < 70; i++) {
      deeplyNested = { inner: deeplyNested };
    }

    expect(() => encodeCbor(deeplyNested, { maxDepth: 10 })).toThrow(CborError);
  });
});
