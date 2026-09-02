import {
  CborError,
  type CborOptions,
  type ResolvedCborOptions,
  UINT32_BASE,
  resolveOptions,
  textDecoder
} from './options.js';

class CborReader {
  private readonly bytes: Uint8Array;
  private offset = 0;
  private readonly options: ResolvedCborOptions;

  constructor(bytes: Uint8Array, options: ResolvedCborOptions) {
    this.bytes = bytes;
    this.options = options;
  }

  decode(): unknown {
    const value = this.readItem(0);
    if (this.offset !== this.bytes.byteLength) throw new CborError('CBOR payload contains trailing data');
    return value;
  }

  private readItem(depth: number): unknown {
    if (depth > this.options.maxDepth) {
      throw new CborError(`CBOR nesting depth exceeds configured limit of ${this.options.maxDepth}`);
    }
    const initial = this.readByte();
    const majorType = initial >>> 5;
    const additionalInformation = initial & 0x1f;

    switch (majorType) {
      case 0:
        return this.readArgument(additionalInformation);
      case 1: {
        const value = -1 - this.readArgument(additionalInformation);
        if (!Number.isSafeInteger(value)) throw new CborError('Decoded CBOR integer is outside the safe range');
        return value;
      }
      case 2: {
        const length = this.readLength(additionalInformation, 'byte string', this.options.maxByteLength);
        return new Uint8Array(this.readBytes(length));
      }
      case 3: {
        const length = this.readLength(additionalInformation, 'text string', this.options.maxByteLength);
        const bytes = this.readBytes(length);
        try {
          return textDecoder.decode(bytes);
        } catch (_error) {
          throw new CborError('CBOR text string contains invalid UTF-8');
        }
      }
      case 4: {
        const length = this.readLength(additionalInformation, 'array', this.options.maxContainerLength);
        const result: unknown[] = [];
        for (let index = 0; index < length; index++) result.push(this.readItem(depth + 1));
        return result;
      }
      case 5: {
        const length = this.readLength(additionalInformation, 'map', this.options.maxContainerLength);
        const result: Record<string, unknown> = {};
        const keys = new Set<string>();
        for (let index = 0; index < length; index++) {
          const key = this.readItem(depth + 1);
          if (typeof key !== 'string') throw new CborError('CBOR map keys must be strings');
          if (keys.has(key)) throw new CborError('CBOR map contains a duplicate key');
          keys.add(key);
          Object.defineProperty(result, key, {
            configurable: true,
            enumerable: true,
            value: this.readItem(depth + 1),
            writable: true
          });
        }
        return result;
      }
      case 6:
        throw new CborError('CBOR tags are not supported');
      case 7:
        return this.readSimple(additionalInformation);
      default:
        throw new CborError('Malformed CBOR major type');
    }
  }

  private readSimple(additionalInformation: number): unknown {
    switch (additionalInformation) {
      case 20:
        return false;
      case 21:
        return true;
      case 22:
        return null;
      case 27: {
        const bytes = this.readBytes(8);
        const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, false);
        if (!Number.isFinite(value)) throw new CborError('Decoded CBOR number must be finite');
        if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
          throw new CborError('Decoded CBOR integer is outside the safe range');
        }
        return value;
      }
      default:
        throw new CborError('Unsupported CBOR simple value or float precision');
    }
  }

  private readByte(): number {
    if (this.offset >= this.bytes.byteLength) throw new CborError('Unexpected end of CBOR payload');
    const value = this.bytes[this.offset]!;
    this.offset++;
    return value;
  }

  private readBytes(length: number): Uint8Array {
    if (this.offset + length > this.bytes.byteLength) {
      throw new CborError('Unexpected end of CBOR payload');
    }
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  private readArgument(additionalInformation: number): number {
    if (additionalInformation < 24) return additionalInformation;
    if (additionalInformation === 24) return this.readByte();
    if (additionalInformation === 25) {
      const bytes = this.readBytes(2);
      return (bytes[0]! << 8) | bytes[1]!;
    }
    if (additionalInformation === 26) {
      const bytes = this.readBytes(4);
      const value = bytes[0]! * 0x1_000_000 + bytes[1]! * 0x1_0000 + bytes[2]! * 0x100 + bytes[3]!;
      if (!Number.isSafeInteger(value)) throw new CborError('Decoded CBOR integer is outside the safe range');
      return value;
    }
    if (additionalInformation === 27) {
      const bytes = this.readBytes(8);
      const high = bytes[0]! * 0x1_000_000 + bytes[1]! * 0x1_0000 + bytes[2]! * 0x100 + bytes[3]!;
      const low = bytes[4]! * 0x1_000_000 + bytes[5]! * 0x1_0000 + bytes[6]! * 0x100 + bytes[7]!;
      const value = high * UINT32_BASE + low;
      if (!Number.isSafeInteger(value)) throw new CborError('Decoded CBOR integer is outside the safe range');
      return value;
    }
    throw new CborError('Unsupported CBOR additional information length');
  }

  private readLength(additionalInformation: number, kind: string, limit: number): number {
    const length = this.readArgument(additionalInformation);
    if (length > limit) {
      throw new CborError(`CBOR ${kind} length ${length} exceeds configured limit of ${limit}`);
    }
    return length;
  }
}

export function decodeCbor(bytes: Uint8Array, options?: CborOptions): unknown {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('CBOR payload must be a Uint8Array');
  const reader = new CborReader(bytes, resolveOptions(options));
  return reader.decode();
}
