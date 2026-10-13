import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RaceState } from '../race/raceState.js'
import { NinesFinancialWagerClient } from '../financial/NinesFinancialWagerClient.js'
import { hashCanonicalJson, type NinesPlaceBetCommandV1 } from '../financial/ninesPlaceBetContract.js'
import { signServiceMessage } from '../financial/serviceMessageAuthentication.js'
import { createPlayerWagerRouter, PLAYER_WAGER_PATH } from './playerWagerRoutes.js'

const apiSecret = 'api-backend-test-secret-at-least-32-characters'
const financialSecret = 'backend-financial-test-secret-at-least-32-characters'
const now = new Date('2026-10-01T00:00:10.000Z')

describe('authenticated player wager gateway', () => {
  afterEach(() => RaceState.setPrecomputedRace(null))

  it('binds the authenticated player to the current private race and converges retries', async () => {
    RaceState.setPrecomputedRace({ raceId: 'race-2cb58993-11dd-4a60-b063-4eec84ba5386',
      raceRef: 'N9-ABCDE-FGHJK', horses: [{ id: 'horse-1', name: 'One' }] } as never)
    const financialCommands: NinesPlaceBetCommandV1[] = []
    const financialClient = new NinesFinancialWagerClient({ baseUrl: 'http://financial.test',
      environment: 'test', keyId: 'backend-financial-v1', secret: financialSecret,
      clock: () => now, fetchImplementation: vi.fn(async (_input, init) => {
        const command = JSON.parse(String(init?.body)) as NinesPlaceBetCommandV1
        financialCommands.push(command)
        return Response.json({ schemaVersion: 'nines-place-bet-result.v1',
          resultType: 'nines_place_bet_result',
          result: financialCommands.length === 1 ? 'accepted' : 'replayed',
          betId: command.betId, playerId: command.playerId, raceId: command.raceId,
          raceRef: command.raceRef, selectionId: command.selectionId, stake: command.stake,
          reservationTransactionId: 'reservation-1', rejectionCode: null,
          effectiveAt: now.toISOString(), correlationId: command.correlationId }, { status: 201 })
      }) })
    const database = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) }
    const app = express().use(express.json()).use(createPlayerWagerRouter({
      environment: 'test', apiKeyId: 'api-backend-v1', apiSecret,
      database: database as never, financialClient, clock: () => now,
    }))
    const body = { schemaVersion: 'nines-player-wager-request.v1',
      playerId: '6e91af93-fdef-42ec-bc45-b252e7352879', raceRef: 'N9-ABCDE-FGHJK',
      selectionId: 'horse-1', stake: { currency: 'NINES', scale: 6, minorUnits: '1000001' },
      idempotencyKey: 'player-wager-1', authenticatedAt: now.toISOString(),
      correlationId: 'browser-correlation-1' }

    for (const requestId of ['6ef4fbb9-d34a-4570-bd26-f71bf06f6b9d',
      '79c9751f-4fe1-48dd-ae50-479ce10a2aca']) {
      const contentHash = hashCanonicalJson(body)
      const signature = signServiceMessage({ method: 'POST', path: PLAYER_WAGER_PATH,
        environment: 'test', serviceId: 'nines-api', keyId: 'api-backend-v1',
        requestId, sentAt: now.toISOString(), contentHash, secret: apiSecret })
      const response = await request(app).post(PLAYER_WAGER_PATH)
        .set({ 'x-nines-service-id': 'nines-api', 'x-nines-key-id': 'api-backend-v1',
          'x-nines-request-id': requestId, 'x-nines-sent-at': now.toISOString(),
          'x-nines-content-sha256': contentHash, 'x-nines-signature': signature,
          'content-type': 'application/json' })
        .send(body)
      expect(response.status).toBe(financialCommands.length === 1 ? 201 : 200)
    }

    expect(financialCommands).toHaveLength(2)
    expect(financialCommands[0]).toMatchObject({ playerId: body.playerId,
      raceId: 'race-2cb58993-11dd-4a60-b063-4eec84ba5386', raceRef: body.raceRef,
      selectionId: body.selectionId, stake: body.stake })
    expect(financialCommands[1]!.betId).toBe(financialCommands[0]!.betId)
    expect(financialCommands[1]!.correlationId).toBe(financialCommands[0]!.correlationId)
    expect(financialCommands[1]!.causationId).toBe(financialCommands[0]!.causationId)
  })
})
