import {
  CborError,
  type CborOptions,
  MAX_UINT32,
  type ResolvedCborOptions,
  resolveOptions,
  textDecoder,
  textEncoder,
  UINT32_BASE
} from './options.js';

class CborWriter {
  private buffer: Uint8Array;
  private offset = 0;
  private readonly maxByteLength: number;

  constructor(maxByteLength: number) {
    this.maxByteLength = maxByteLength;
    this.buffer = new Uint8Array(Math.min(256, maxByteLength));
  }

  writeByte(value: number): void {
    this.ensureCapacity(1);
    this.buffer[this.offset] = value;
    this.offset++;
  }

  writeBytes(bytes: Uint8Array): void {
    this.ensureCapacity(bytes.byteLength);
    this.buffer.set(bytes, this.offset);
    this.offset += bytes.byteLength;
  }

  writeUint16(value: number): void {
    this.ensureCapacity(2);
    this.buffer[this.offset] = value >>> 8;
    this.buffer[this.offset + 1] = value;
    this.offset += 2;
  }

  writeUint32(value: number): void {
    this.ensureCapacity(4);
    this.buffer[this.offset] = value >>> 24;
    this.buffer[this.offset + 1] = value >>> 16;
    this.buffer[this.offset + 2] = value >>> 8;
    this.buffer[this.offset + 3] = value;
    this.offset += 4;
  }

  writeUint64(value: number): void {
    const high = Math.floor(value / UINT32_BASE);
    const low = value - high * UINT32_BASE;
    this.writeUint32(high);
    this.writeUint32(low);
  }

  writeFloat64(value: number): void {
    this.ensureCapacity(9);
    this.buffer[this.offset] = 0xfb;
    new DataView(this.buffer.buffer).setFloat64(this.offset + 1, value, false);
    this.offset += 9;
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.offset);
  }

  private ensureCapacity(additionalBytes: number): void {
    const required = this.offset + additionalBytes;
    if (required > this.maxByteLength) {
      throw new CborError(`CBOR byte length exceeds configured limit of ${this.maxByteLength}`);
    }
    if (required <= this.buffer.byteLength) return;

    let capacity = Math.max(1, this.buffer.byteLength);
    while (capacity < required) capacity = Math.min(this.maxByteLength, Math.max(required, capacity * 2));
    const expanded = new Uint8Array(capacity);
    expanded.set(this.buffer);
    this.buffer = expanded;
  }
}

function writeArgument(writer: CborWriter, majorType: number, value: number): void {
  const prefix = majorType << 5;
  if (value < 24) {
    writer.writeByte(prefix | value);
  } else if (value <= 0xff) {
    writer.writeByte(prefix | 24);
    writer.writeByte(value);
  } else if (value <= 0xffff) {
    writer.writeByte(prefix | 25);
    writer.writeUint16(value);
  } else if (value <= MAX_UINT32) {
    writer.writeByte(prefix | 26);
    writer.writeUint32(value);
  } else {
    writer.writeByte(prefix | 27);
    writer.writeUint64(value);
  }
}

function encodeItem(writer: CborWriter, value: unknown, depth: number, options: ResolvedCborOptions): void {
  if (depth > options.maxDepth) {
    throw new CborError(`CBOR nesting depth exceeds configured limit of ${options.maxDepth}`);
  }

  if (value === null) {
    writer.writeByte(0xf6);
    return;
  }
  if (value === false) {
    writer.writeByte(0xf4);
    return;
  }
  if (value === true) {
    writer.writeByte(0xf5);
    return;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CborError('Cannot encode non-finite number in CBOR');
    }
    if (Number.isInteger(value)) {
      if (value >= 0) {
        if (value > Number.MAX_SAFE_INTEGER) throw new CborError('Integer exceeds safe range');
        writeArgument(writer, 0, value);
        return;
      }
      const magnitude = -1 - value;
      if (magnitude < 0 || magnitude > Number.MAX_SAFE_INTEGER) throw new CborError('Negative integer exceeds safe range');
      writeArgument(writer, 1, magnitude);
      return;
    }
    writer.writeFloat64(value);
    return;
  }

  if (typeof value === 'string') {
    const bytes = textEncoder.encode(value);
    if (bytes.byteLength > options.maxByteLength) {
      throw new CborError(`Text string exceeds byte length limit of ${options.maxByteLength}`);
    }
    writeArgument(writer, 3, bytes.byteLength);
    writer.writeBytes(bytes);
    return;
  }

  if (value instanceof Uint8Array) {
    if (value.byteLength > options.maxByteLength) {
      throw new CborError(`Byte string exceeds byte length limit of ${options.maxByteLength}`);
    }
    writeArgument(writer, 2, value.byteLength);
    writer.writeBytes(value);
    return;
  }

  if (Array.isArray(value)) {
    if (value.length > options.maxContainerLength) {
      throw new CborError(`Array length exceeds configured limit of ${options.maxContainerLength}`);
    }
    writeArgument(writer, 4, value.length);
    for (const item of value) {
      encodeItem(writer, item, depth + 1, options);
    }
    return;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length > options.maxContainerLength) {
      throw new CborError(`Map entries count exceeds configured limit of ${options.maxContainerLength}`);
    }
    writeArgument(writer, 5, entries.length);
    for (const [k, v] of entries) {
      encodeItem(writer, k, depth + 1, options);
      encodeItem(writer, v, depth + 1, options);
    }
    return;
  }

  throw new CborError(`Cannot encode unsupported type in CBOR: ${typeof value}`);
}

export function encodeCbor(value: unknown, options?: CborOptions): Uint8Array {
  const resolved = resolveOptions(options);
  const writer = new CborWriter(resolved.maxByteLength);
  encodeItem(writer, value, 0, resolved);
  return writer.finish();
}
