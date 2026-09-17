import { describe, it, expect } from 'vitest'
import {
  PROTOCOL_NAMESPACE,
  PROTOCOL_VERSION,
  MAX_MESSAGE_BYTES,
  DEFAULT_TIMEOUT_MS,
  ErrorCode,
  validateProtocolMessage,
  validateWorkerRequest,
  validateWorkerResponse,
  validateProgressEvent,
  createErrorResponse,
  createSuccessResponse,
  isErrorResponse,
  isSuccessResponse,
  createLineId,
  createDisplayIndex,
  createGeneration,
  type LineId,
  type DisplayIndex,
  type Generation,
  type RpcResponse,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerEvent,
} from '../src/protocol.js'

describe('Worker RPC Protocol', () => {
  describe('Constants', () => {
    it('should have correct namespace', () => {
      expect(PROTOCOL_NAMESPACE).toBe('jsonl-explorer')
    })

    it('should have version 1', () => {
      expect(PROTOCOL_VERSION).toBe(1)
    })

    it('should have 10MB max message size', () => {
      expect(MAX_MESSAGE_BYTES).toBe(10 * 1024 * 1024)
    })

    it('should have 30s default timeout', () => {
      expect(DEFAULT_TIMEOUT_MS).toBe(30_000)
    })
  })

  describe('ErrorCode', () => {
    it('should have all expected error codes', () => {
      expect(ErrorCode.UNKNOWN).toBe('UNKNOWN')
      expect(ErrorCode.INVALID_REQUEST).toBe('INVALID_REQUEST')
      expect(ErrorCode.SOURCE_INIT_FAILED).toBe('SOURCE_INIT_FAILED')
      expect(ErrorCode.INDEXING_FAILED).toBe('INDEXING_FAILED')
      expect(ErrorCode.FILTER_FAILED).toBe('FILTER_FAILED')
      expect(ErrorCode.INVALID_JQ_PROGRAM).toBe('INVALID_JQ_PROGRAM')
      expect(ErrorCode.ROW_NOT_FOUND).toBe('ROW_NOT_FOUND')
      expect(ErrorCode.EDIT_FAILED).toBe('EDIT_FAILED')
      expect(ErrorCode.INVALID_JSON).toBe('INVALID_JSON')
      expect(ErrorCode.EXPORT_FAILED).toBe('EXPORT_FAILED')
      expect(ErrorCode.HANDOVER_PAYLOAD_TOO_LARGE).toBe('HANDOVER_PAYLOAD_TOO_LARGE')
      expect(ErrorCode.URL_FETCH_FAILED).toBe('URL_FETCH_FAILED')
    })
  })

  describe('validateProtocolMessage', () => {
    it('should reject non-objects', () => {
      expect(validateProtocolMessage(null)).toBe(false)
      expect(validateProtocolMessage('string')).toBe(false)
      expect(validateProtocolMessage(123)).toBe(false)
    })

    it('should reject wrong namespace', () => {
      expect(validateProtocolMessage({ ns: 'wrong', v: 1, type: 'test' })).toBe(false)
    })

    it('should reject wrong version', () => {
      expect(validateProtocolMessage({ ns: 'jsonl-explorer', v: 2, type: 'test' })).toBe(false)
    })

    it('should reject missing type', () => {
      expect(validateProtocolMessage({ ns: 'jsonl-explorer', v: 1 })).toBe(false)
    })

    it('should accept valid message', () => {
      expect(validateProtocolMessage({ ns: 'jsonl-explorer', v: 1, type: 'test' })).toBe(true)
    })
  })

  describe('validateWorkerRequest', () => {
    it('should reject non-requests', () => {
      expect(validateWorkerRequest({ ns: 'jsonl-explorer', v: 1, type: 'initFile' })).toBe(false)
    })

    it('should accept valid request with requestId', () => {
      expect(validateWorkerRequest({
        ns: 'jsonl-explorer',
        v: 1,
        type: 'initFile',
        requestId: 'req-1',
        operationId: 'op-1',
      })).toBe(true)
    })

    it('should reject request without requestId', () => {
      expect(validateWorkerRequest({
        ns: 'jsonl-explorer',
        v: 1,
        type: 'initFile',
        operationId: 'op-1',
      })).toBe(false)
    })
  })

  describe('validateWorkerResponse', () => {
    it('should accept valid success response', () => {
      expect(validateWorkerResponse({
        ns: 'jsonl-explorer',
        v: 1,
        type: 'initFile',
        requestId: 'req-1',
        ok: true,
        value: { totalRows: 100 },
      })).toBe(true)
    })

    it('should accept valid error response', () => {
      expect(validateWorkerResponse({
        ns: 'jsonl-explorer',
        v: 1,
        type: 'initFile',
        requestId: 'req-1',
        ok: false,
        error: { code: 'SOURCE_INIT_FAILED', message: 'Failed' },
      })).toBe(true)
    })

    it('should reject response without requestId', () => {
      expect(validateWorkerResponse({
        ns: 'jsonl-explorer',
        v: 1,
        type: 'initFile',
        ok: true,
        value: {},
      })).toBe(false)
    })
  })

  describe('runJq (TSK0033 local jq search)', () => {
    it('validates a runJq request (document sent by value, no generation)', () => {
      const request = {
        ns: 'jsonl-explorer',
        v: 1,
        type: 'runJq',
        requestId: 'req-jq',
        lineId: 3,
        program: '.items[].id',
        text: '{"items":[{"id":1}]}',
      } satisfies import('../src/protocol.js').RunJqRequest
      expect(validateWorkerRequest(request)).toBe(true)
      // Staleness is caller-guarded: the request carries no generation.
      expect('generation' in request).toBe(false)
    })

    it('validates a runJq success response (outputs in emission order)', () => {
      const response = {
        ns: 'jsonl-explorer',
        v: 1,
        type: 'runJq',
        requestId: 'req-jq',
        ok: true,
        value: { lineId: 3, outputs: [1, 2] },
      } satisfies RpcResponse<import('../src/protocol.js').RunJqResponse['value']>
      expect(validateWorkerResponse(response)).toBe(true)
      const success = createSuccessResponse(response.requestId, { lineId: 3, outputs: [] })
      expect(isSuccessResponse(success)).toBe(true)
    })
  })

  describe('validateProgressEvent', () => {
    it('should accept valid progress event', () => {
      expect(validateProgressEvent({
        ns: 'jsonl-explorer',
        v: 1,
        type: 'indexProgress',
        operationId: 'op-1',
        progress: 50,
      })).toBe(true)
    })

    it('should reject event without operationId', () => {
      expect(validateProgressEvent({
        ns: 'jsonl-explorer',
        v: 1,
        type: 'indexProgress',
        progress: 50,
      })).toBe(false)
    })
  })

  describe('Response helpers', () => {
    it('should create error response', () => {
      const resp = createErrorResponse('req-1', 'SOURCE_INIT_FAILED', 'Failed to init')
      expect(resp.requestId).toBe('req-1')
      expect(resp.ok).toBe(false)
      expect(resp.error.code).toBe('SOURCE_INIT_FAILED')
      expect(resp.error.message).toBe('Failed to init')
    })

    it('should create success response', () => {
      const resp = createSuccessResponse('req-1', { rows: 100 })
      expect(resp.requestId).toBe('req-1')
      expect(resp.ok).toBe(true)
      expect(resp.value).toEqual({ rows: 100 })
    })

    it('should detect error response', () => {
      const errorResp = createErrorResponse('req-1', ErrorCode.UNKNOWN, 'Error')
      const successResp = createSuccessResponse('req-1', {})

      expect(isErrorResponse(errorResp)).toBe(true)
      expect(isErrorResponse(successResp)).toBe(false)
    })

    it('should detect success response', () => {
      const successResp = createSuccessResponse('req-1', {})
      expect(isSuccessResponse(successResp)).toBe(true)
      expect(isSuccessResponse(createErrorResponse('req-1', ErrorCode.UNKNOWN, 'Error'))).toBe(false)
    })
  })

  describe('Branded types', () => {
    it('should create LineId', () => {
      const id = createLineId(42)
      expect(id).toBe(42)
      // Type check: LineId should not be assignable to number without cast
      const _check: LineId = id
      expect(_check).toBe(42)
    })

    it('should create DisplayIndex', () => {
      const idx = createDisplayIndex(10)
      expect(idx).toBe(10)
      const _check: DisplayIndex = idx
      expect(_check).toBe(10)
    })

    it('should create Generation', () => {
      const gen = createGeneration(5)
      expect(gen).toBe(5)
      const _check: Generation = gen
      expect(_check).toBe(5)
    })
  })

  describe('Type guards', () => {
    it('should correctly identify error response', () => {
      const errorResp = createErrorResponse('req-1', ErrorCode.UNKNOWN, 'Error')
      const successResp = createSuccessResponse('req-1', { data: 'ok' })

      expect(isErrorResponse(errorResp)).toBe(true)
      expect(isErrorResponse(successResp)).toBe(false)
    })

    it('should correctly identify success response', () => {
      const successResp = createSuccessResponse('req-1', { data: 'ok' })
      const errorResp = createErrorResponse('req-1', ErrorCode.UNKNOWN, 'Error')

      expect(isSuccessResponse(successResp)).toBe(true)
      expect(isSuccessResponse(errorResp)).toBe(false)
    })
  })
})