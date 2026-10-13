import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { NinesFinancialRaceLifecycleClient,
  NinesFinancialRaceLifecycleClientError } from './NinesFinancialRaceLifecycleClient.js'
import { createLifecycleEventsForRace, nextRaceStartAt } from './raceLifecycleFactory.js'
import { loadRaceLifecycleDeliveryConfig } from './raceLifecycleConfig.js'
import { canonicalRaceLifecycleJson, createRaceLifecycleEvent,
  raceLifecycleEvidenceHash, type NinesRaceLifecycleAckV1,
  type NinesRaceLifecycleEventV1 } from './raceLifecycleContract.js'
import { RaceLifecycleDeliveryWorker, type ClaimedRaceLifecycleEvent,
  type RaceLifecycleOutboxRepository } from './raceLifecycleOutbox.js'

const fixture = JSON.parse(fs.readFileSync(path.resolve(process.cwd(),
  'contracts/nines-race-lifecycle-v1.fixtures.json'), 'utf8')) as Record<string, NinesRaceLifecycleEventV1>
const secret = 'w2-backend-financial-test-secret-at-least-32-characters'

function ack(event: NinesRaceLifecycleEventV1, result: 'projected' | 'replayed' = 'projected'):
NinesRaceLifecycleAckV1 {
  return { schemaVersion: 'nines-race-lifecycle-ack.v1', resultType: 'nines_race_lifecycle_ack',
    result, raceId: event.raceId, raceRef: event.raceRef,
    lifecycleEventId: event.lifecycleEventId, lifecycleSequence: event.lifecycleSequence,
    eventType: event.eventType, poolStatus: event.lifecycleSequence === 1 ? 'open' : 'frozen',
    effectiveAt: event.occurredAt, correlationId: event.correlationId }
}

describe('authenticated race lifecycle contract and delivery', () => {
  it('independently reproduces canonical open/close evidence and stable event identities', () => {
    const common = fixture.validOpen
    const open = createRaceLifecycleEvent({ eventType: 'nines_race_opened.v1',
      environment: common.environment, raceId: common.raceId, raceRef: common.raceRef,
      bettingOpensAt: common.bettingOpensAt, bettingClosesAt: common.bettingClosesAt,
      selections: common.selections, economicPolicy: common.economicPolicy,
      correlationId: common.correlationId, causationId: common.causationId,
      occurredAt: common.occurredAt })
    const closeFixture = fixture.validClose
    const close = createRaceLifecycleEvent({ eventType: 'nines_race_betting_closed.v1',
      environment: closeFixture.environment, raceId: closeFixture.raceId,
      raceRef: closeFixture.raceRef, bettingOpensAt: closeFixture.bettingOpensAt,
      bettingClosesAt: closeFixture.bettingClosesAt, selections: closeFixture.selections,
      economicPolicy: closeFixture.economicPolicy, correlationId: closeFixture.correlationId,
      causationId: closeFixture.causationId, occurredAt: closeFixture.occurredAt })
    expect(open).toEqual(fixture.validOpen)
    expect(close).toEqual(fixture.validClose)
    expect(fixture.replay).toEqual(fixture.validOpen)
    const { evidenceHash: _hash, ...conflictingEvidence } = fixture.conflict
    expect(raceLifecycleEvidenceHash(conflictingEvidence)).toBe(fixture.conflict.evidenceHash)
    expect(fixture.conflict.lifecycleEventId).toBe(open.lifecycleEventId)
    expect(fixture.conflict.evidenceHash).not.toBe(open.evidenceHash)
  })

  it('maps authoritative runners directly to selections and snapshots explicit policy', () => {
    const events = createLifecycleEventsForRace({ raceId: fixture.validOpen.raceId,
      raceRef: fixture.validOpen.raceRef, horses: fixture.validOpen.selections.map((selection) => ({
        id: selection.runnerId, name: selection.displayName, baseSpeed: 1,
        accelVariance: 0, rngSeed: 1 })) },
    new Date('2026-04-22T12:00:00.000Z'), {
      NODE_ENV: 'test', NINES_FINANCIAL_RACE_LIFECYCLE_ENABLED: 'true',
      NINES_FINANCIAL_BASE_URL: 'http://financial.test',
      NINES_FINANCIAL_AUTH_KEY_ID: 'backend-lifecycle-v1',
      NINES_FINANCIAL_AUTH_HMAC_SECRET: secret, NINES_RACE_HOUSE_TAKE_BPS: '1000',
    })
    expect(events).toEqual([fixture.validOpen, fixture.validClose])
    expect(events[0]?.selections.every((entry) => entry.runnerId === entry.selectionId)).toBe(true)
    expect(events[0]?.economicPolicy.houseTakeBps).toBe(1000)
    expect(nextRaceStartAt(new Date('2026-04-22T12:00:29.999Z')).toISOString())
      .toBe('2026-04-22T12:00:30.000Z')
  })

  it('requires explicit policy and HTTPS for enabled production delivery', () => {
    const base = { NODE_ENV: 'production', NINES_FINANCIAL_RACE_LIFECYCLE_ENABLED: 'true',
      NINES_FINANCIAL_BASE_URL: 'https://financial.internal',
      NINES_FINANCIAL_AUTH_KEY_ID: 'backend-lifecycle-v1',
      NINES_FINANCIAL_AUTH_HMAC_SECRET: secret }
    expect(() => loadRaceLifecycleDeliveryConfig('production', base)).toThrow('HOUSE_TAKE')
    expect(() => loadRaceLifecycleDeliveryConfig('production', { ...base,
      NINES_RACE_HOUSE_TAKE_BPS: '1000', NINES_FINANCIAL_BASE_URL: 'http://financial' }))
      .toThrow('HTTPS')
  })

  it('retries stable economic evidence with a fresh transport nonce', async () => {
    const requests: Array<{ body: string; nonce: string; hash: string }> = []
    let sequence = 0
    const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      requests.push({ body: String(init?.body), nonce: headers['x-nines-request-id'],
        hash: headers['x-nines-content-sha256'] })
      if (requests.length === 1) throw new TypeError('response lost')
      return new Response(JSON.stringify(ack(fixture.validOpen, 'replayed')), { status: 200 })
    }) as typeof fetch
    const client = new NinesFinancialRaceLifecycleClient({ baseUrl: 'http://financial.test',
      environment: 'test', keyId: 'backend-lifecycle-v1', secret,
      fetchImplementation: fetcher, clock: () => new Date('2026-04-22T12:00:01.000Z'),
      requestIdFactory: () => sequence++ === 0 ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' :
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', maxAttempts: 2 })
    await expect(client.deliver(fixture.validOpen)).resolves.toMatchObject({ result: 'replayed' })
    expect(requests).toHaveLength(2)
    expect(requests[0]?.body).toBe(requests[1]?.body)
    expect(requests[0]?.body).toBe(canonicalRaceLifecycleJson(fixture.validOpen))
    expect(requests[0]?.nonce).not.toBe(requests[1]?.nonce)
    expect(requests[0]?.hash).toBe(createHash('sha256').update(requests[0]!.body).digest('hex'))
  })

  it('acknowledges open/close and does not retry a lifecycle conflict', async () => {
    for (const event of [fixture.validOpen, fixture.validClose]) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(ack(event)), { status: 201 })) as typeof fetch
      const client = new NinesFinancialRaceLifecycleClient({ baseUrl: 'http://financial.test',
        environment: 'test', keyId: 'key', secret, fetchImplementation: fetcher })
      await expect(client.deliver(event)).resolves.toMatchObject({ lifecycleEventId: event.lifecycleEventId })
    }
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: {
      code: 'RACE_LIFECYCLE_IDENTITY_CONFLICT', retryable: false } }), { status: 409 })) as typeof fetch
    const client = new NinesFinancialRaceLifecycleClient({ baseUrl: 'http://financial.test',
      environment: 'test', keyId: 'key', secret, fetchImplementation: fetcher, maxAttempts: 2 })
    await expect(client.deliver(fixture.conflict)).rejects.toMatchObject({
      code: 'RACE_LIFECYCLE_IDENTITY_CONFLICT', retryable: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(() => new NinesFinancialRaceLifecycleClient({ baseUrl: 'http://financial',
      environment: 'production', keyId: 'key', secret })).toThrow('HTTPS')
  })

  it('recovers a claimed durable event after a worker/network failure', async () => {
    class FakeRepository implements RaceLifecycleOutboxRepository {
      deliveredAt: Date | null = null
      failures = 0
      claimCount = 0
      async claim(): Promise<ClaimedRaceLifecycleEvent | null> {
        if (this.deliveredAt) return null
        this.claimCount += 1
        return { event: fixture.validOpen, payloadHash: fixture.validOpen.evidenceHash,
          attemptCount: this.claimCount }
      }
      async delivered(): Promise<void> { this.deliveredAt = new Date() }
      async failed(): Promise<void> { this.failures += 1 }
    }
    const repository = new FakeRepository()
    const failing = new RaceLifecycleDeliveryWorker(repository, { deliver: async () => {
      throw new NinesFinancialRaceLifecycleClientError('offline', true, null, 'NETWORK')
    } }, 1)
    await failing.runOnce()
    const restarted = new RaceLifecycleDeliveryWorker(repository, {
      deliver: async () => ack(fixture.validOpen, 'replayed'),
    }, 1)
    await restarted.runOnce()
    expect(repository.failures).toBe(1)
    expect(repository.claimCount).toBe(2)
    expect(repository.deliveredAt).not.toBeNull()
  })
})

