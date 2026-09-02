import { decodeCbor, encodeCbor } from './cbor/index.js';
import {
  DEFAULT_MAX_FRAME_LENGTH,
  FrameDecoder,
  type FrameDecoderOptions,
  assertCompleteFrame,
  encodeFrame
} from './framing.js';

export class ProtocolValidationError extends Error {
  constructor(message: string, _value?: unknown) {
    super(message);
    this.name = 'ProtocolValidationError';
  }
}

function boundedErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Unknown codec error';
  return error.message.length <= 500 ? error.message : `${error.message.slice(0, 497)}...`;
}

/**
 * 通用协议数据包 CBOR 帧编码器
 */
export function encodeProtocolPayload<T>(
  value: T,
  validator?: (val: unknown) => boolean,
  options?: FrameDecoderOptions
): Uint8Array {
  if (validator && !validator(value)) {
    throw new ProtocolValidationError('Value failed protocol validation');
  }
  try {
    const maxFrameLength = options?.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
    const cborBytes = encodeCbor(value, { maxByteLength: maxFrameLength });
    const frame = encodeFrame(cborBytes);
    assertCompleteFrame(frame, { maxFrameLength });
    return frame;
  } catch (error) {
    if (error instanceof ProtocolValidationError) throw error;
    throw new ProtocolValidationError(`Unable to encode protocol frame: ${boundedErrorMessage(error)}`);
  }
}

/**
 * 通用协议数据包 CBOR 帧解码器
 */
export function decodeProtocolPayload<T = unknown>(
  frameBytes: Uint8Array,
  validator?: (val: unknown) => val is T,
  options?: FrameDecoderOptions
): T {
  const maxFrameLength = options?.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
  assertCompleteFrame(frameBytes, { maxFrameLength });
  const payloadBytes = frameBytes.subarray(4);
  const decoded = decodeCbor(payloadBytes, { maxByteLength: maxFrameLength });
  if (validator && !validator(decoded)) {
    throw new ProtocolValidationError('Decoded payload failed protocol validation');
  }
  return decoded as T;
}

/**
 * 流式协议帧解码器
 */
export class StreamPayloadDecoder<T = unknown> {
  private frames: FrameDecoder;
  private validator?: (val: unknown) => val is T;
  private maxFrameLength: number;

  constructor(validator?: (val: unknown) => val is T, options?: FrameDecoderOptions) {
    this.frames = new FrameDecoder(options);
    this.validator = validator;
    this.maxFrameLength = options?.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
  }

  push(chunk: Uint8Array): T[] {
    const payloads = this.frames.push(chunk);
    const results: T[] = [];
    for (const payload of payloads) {
      const decoded = decodeCbor(payload, { maxByteLength: this.maxFrameLength });
      if (this.validator && !this.validator(decoded)) {
        throw new ProtocolValidationError('Decoded chunk failed validation');
      }
      results.push(decoded as T);
    }
    return results;
  }

  end(): void {
    this.frames.end();
  }
}
