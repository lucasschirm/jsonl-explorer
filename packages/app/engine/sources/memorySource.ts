/**
 * MemorySource — worker-owned byte source for handover payloads.
 *
 * Accepts either a UTF-8 text payload (encoded inside the worker) or an
 * ArrayBuffer that was transferred from the main thread. Transferred buffers
 * are wrapped, not copied: the worker takes ownership and the main thread's
 * reference is detached by the postMessage transfer.
 *
 * Payload size is capped (ADR-003 `maxHandoverPayloadBytes`, 100 MiB by
 * default) to bound worker memory; oversized payloads throw a typed
 * `PayloadTooLargeError`.
 */

import { THRESHOLDS } from '../config/adr.js'

import { AbstractJsonlSource, normalizeLength, normalizeOffset, PayloadTooLargeError } from './source.js'

export interface MemorySourceOptions {
  /** Maximum accepted payload size in bytes. Defaults to the ADR threshold. */
  maxPayloadBytes?: number
}

export class MemorySource extends AbstractJsonlSource {
  readonly name: string
  private data: Uint8Array | null
  private readonly maxPayloadBytes: number

  constructor(
    name: string,
    payload: string | ArrayBuffer,
    options: MemorySourceOptions = {},
  ) {
    super()
    this.name = name
    this.maxPayloadBytes = options.maxPayloadBytes ?? THRESHOLDS.maxHandoverPayloadBytes
    this.data = null
    const encoded = MemorySource.encodePayload(payload)
    if (encoded.byteLength > this.maxPayloadBytes) {
      throw new PayloadTooLargeError(encoded.byteLength, this.maxPayloadBytes)
    }
    this.data = encoded
  }

  async getSize(): Promise<bigint> {
    this.assertActive()
    return BigInt(this.activeData().byteLength)
  }

  async readRange(offset: bigint | number, length: number): Promise<Uint8Array> {
    this.assertActive()
    const data = this.activeData()
    const size = BigInt(data.byteLength)
    const start = normalizeOffset(offset)
    if (start >= size) return new Uint8Array(0)
    const requestedEnd = start + BigInt(normalizeLength(length))
    const end = requestedEnd > size ? size : requestedEnd
    return data.subarray(Number(start), Number(end))
  }

  protected override release(): void {
    // Drop the reference so the (potentially large) buffer can be collected.
    this.data = null
  }

  /**
   * Encodes the handover payload into bytes.
   * - strings are UTF-8 encoded here, in the worker
   * - ArrayBuffers are wrapped (ownership transferred, no copy)
   */
  private static encodePayload(payload: string | ArrayBuffer): Uint8Array {
    if (typeof payload === 'string') {
      return new TextEncoder().encode(payload)
    }
    return new Uint8Array(payload)
  }

  private activeData(): Uint8Array {
    const data = this.data
    if (data === null) throw new Error('Internal error: memory source data missing')
    return data
  }
}
