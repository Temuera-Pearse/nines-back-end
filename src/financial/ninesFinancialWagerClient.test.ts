import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  NinesFinancialWagerClient,
  NinesFinancialWagerClientError,
} from './NinesFinancialWagerClient.js'
import {
  canonicalizeJson,
  createNinesPlaceBetCommand,
  createTrustedPlayerIdentity,
  hashCanonicalJson,
  type NinesPlaceBetCommandV1,
  type NinesPlaceBetResultV1,
} from './ninesPlaceBetContract.js'
import { loadNinesFinancialWagerClientOptions } from './ninesFinancialWagerConfig.js'

const fixture = JSON.parse(fs.readFileSync(path.resolve(
  process.cwd(), 'contracts/nines-place-bet-v1.fixtures.json'), 'utf8')) as Record<string, any>
const secret = 'w1-backend-financial-test-secret-at-least-32-characters'

function client(fetchImplementation: typeof fetch, requestIds = [
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
]) {
  let index = 0
  return new NinesFinancialWagerClient({ baseUrl: 'http://financial.test', environment: 'test',
    keyId: 'backend-wager-v1', secret, fetchImplementation,
    clock: () => new Date('2026-04-22T12:00:00.000Z'),
    requestIdFactory: () => requestIds[index++] ?? crypto.randomUUID(), maxAttempts: 2 })
}

describe('NINES Financial wager contract and client', () => {
  it('independently reproduces the canonical cross-repository fixture', () => {
    const playerIdentity = createTrustedPlayerIdentity({
      playerId: fixture.command.playerId,
      assertionId: fixture.command.playerIdentity.assertionId,
      authenticatedAt: fixture.command.playerIdentity.authenticatedAt,
      expiresAt: fixture.command.playerIdentity.expiresAt,
    })
    const command = createNinesPlaceBetCommand({
      environment: 'test', betId: fixture.command.betId, playerId: fixture.command.playerId,
      raceId: fixture.command.raceId, raceRef: fixture.command.raceRef,
      selectionId: fixture.command.selectionId, stakeMinor: fixture.command.stake.minorUnits,
      idempotencyKey: fixture.command.idempotencyKey, requestedAt: fixture.command.requestedAt,
      correlationId: fixture.command.correlationId, causationId: fixture.command.causationId,
      playerIdentity,
    })
    expect(command).toEqual(fixture.command)
    const { evidenceHash: _evidenceHash, ...evidence } = command
    expect(hashCanonicalJson(evidence as any)).toBe(fixture.hashes.commandEvidenceHash)
    expect(hashCanonicalJson(command as any)).toBe(fixture.hashes.commandTransportHash)
    expect(hashCanonicalJson(fixture.acceptedResponse)).toBe(fixture.hashes.acceptedResponseHash)
    expect(hashCanonicalJson(fixture.replayResponse)).toBe(fixture.hashes.replayResponseHash)
    expect(hashCanonicalJson(fixture.rejectionResponse)).toBe(fixture.hashes.rejectionResponseHash)
  })

  it('binds player identity and preserves private raceId/public raceRef semantics', () => {
    const assertion = createTrustedPlayerIdentity({ playerId: fixture.command.playerId,
      authenticatedAt: fixture.command.playerIdentity.authenticatedAt,
      expiresAt: fixture.command.playerIdentity.expiresAt })
    expect(() => createNinesPlaceBetCommand({ environment: 'test', betId: fixture.command.betId,
      playerId: '55555555-5555-4555-8555-555555555555', raceId: fixture.command.raceId,
      raceRef: fixture.command.raceRef, selectionId: fixture.command.selectionId,
      stakeMinor: '1', idempotencyKey: 'bound-player', requestedAt: fixture.command.requestedAt,
      correlationId: 'corr_bound', causationId: 'cause_bound', playerIdentity: assertion,
    })).toThrow('not bound')
    expect(fixture.command.raceId).toMatch(/^race-/)
    expect(fixture.command.raceRef).toMatch(/^N9-/)
    expect(() => createTrustedPlayerIdentity({ playerId: fixture.command.playerId,
      authenticatedAt: '2026-04-22T12:00:00.000Z',
      expiresAt: '2026-04-22T12:05:00.001Z' })).toThrow('five minutes')
  })

  it('retries a lost response with an immutable body and fresh signed nonce', async () => {
    const requests: Array<{ body: string; nonce: string; signature: string }> = []
    const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      requests.push({ body: String(init?.body), nonce: headers['x-nines-request-id'],
        signature: headers['x-nines-signature'] })
      if (requests.length === 1) throw new TypeError('response lost')
      return new Response(JSON.stringify(fixture.replayResponse), { status: 200,
        headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const result = await client(fetcher).placeBet(fixture.command as NinesPlaceBetCommandV1)
    expect(result).toEqual(fixture.replayResponse)
    expect(requests).toHaveLength(2)
    expect(requests[0]?.body).toBe(requests[1]?.body)
    expect(requests[0]?.nonce).not.toBe(requests[1]?.nonce)
    expect(requests[0]?.signature).not.toBe(requests[1]?.signature)
    expect(requests[0]?.body).toBe(canonicalizeJson(fixture.command))
  })

  it('handles accepted/replayed responses and does not retry a business conflict', async () => {
    for (const responseBody of [fixture.acceptedResponse, fixture.replayResponse] as NinesPlaceBetResultV1[]) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(responseBody), { status: 200 })) as typeof fetch
      expect((await client(fetcher).placeBet(fixture.command)).result).toBe(responseBody.result)
    }
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: {
      code: 'IDEMPOTENCY_PAYLOAD_MISMATCH', retryable: false } }), { status: 409 })) as typeof fetch
    await expect(client(fetcher).placeBet(fixture.command)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_PAYLOAD_MISMATCH', retryable: false, status: 409 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('enforces production HTTPS and classifies timeouts as retryable', async () => {
    expect(() => new NinesFinancialWagerClient({ baseUrl: 'http://financial.internal',
      environment: 'production', keyId: 'key', secret })).toThrow('HTTPS')
    const fetcher = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'),
        { name: 'AbortError' })))
    })) as typeof fetch
    const timeoutClient = new NinesFinancialWagerClient({ baseUrl: 'http://financial.test',
      environment: 'test', keyId: 'key', secret, fetchImplementation: fetcher,
      timeoutMs: 1, maxAttempts: 1 })
    await expect(timeoutClient.placeBet(fixture.command)).rejects.toEqual(
      expect.objectContaining({
        code: 'FINANCIAL_TIMEOUT', retryable: true, status: null }))
  })

  it('loads the narrow production client configuration without fallback credentials', () => {
    const options = loadNinesFinancialWagerClientOptions('production', {
      NINES_FINANCIAL_BASE_URL: 'https://financial.internal',
      NINES_FINANCIAL_AUTH_KEY_ID: 'backend-wager-v1',
      NINES_FINANCIAL_AUTH_HMAC_SECRET: secret,
      NINES_FINANCIAL_WAGER_TIMEOUT_MS: '2500',
      NINES_FINANCIAL_WAGER_MAX_ATTEMPTS: '3',
    })
    expect(options).toMatchObject({ timeoutMs: 2500, maxAttempts: 3,
      baseUrl: 'https://financial.internal', environment: 'production' })
    expect(() => loadNinesFinancialWagerClientOptions('production', {})).toThrow('required')
  })
})
