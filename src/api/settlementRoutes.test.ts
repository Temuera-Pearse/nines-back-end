import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConflictError } from '../user/errors.js'

const { settlementServiceMock } = vi.hoisted(() => ({
  settlementServiceMock: {
    settleRaceBets: vi.fn(async () => ({
      raceId: 'race-1',
      winnerId: 'horse-3',
      settledAt: new Date('2026-03-22T00:00:00.000Z'),
      processedCount: 2,
      wonCount: 1,
      lostCount: 1,
      totalPayoutMinor: 2400n,
      settledBets: [
        {
          bet: {
            id: 'bet-1',
            userId: 'user-1',
            walletId: 'wallet-1',
            raceId: 'race-1',
            currency: 'USD',
            betType: 'win',
            selectionId: 'horse-3',
            stakeMinor: 1200n,
            payoutMinor: 2400n,
            status: 'settled',
            resultStatus: 'won',
            placedAt: new Date('2026-03-22T00:00:00.000Z'),
            settledAt: new Date('2026-03-22T00:01:00.000Z'),
            refundedAt: null,
            metadata: {},
            createdAt: new Date('2026-03-22T00:00:00.000Z'),
            updatedAt: new Date('2026-03-22T00:01:00.000Z'),
          },
          ledgerEntry: {
            id: 10,
            walletId: 'wallet-1',
            entryType: 'settlement_credit',
            deltaMinor: 2400n,
            balanceAfterMinor: 6200n,
            referenceType: 'bet',
            referenceId: 'bet-1',
            metadata: { raceId: 'race-1' },
            createdAt: new Date('2026-03-22T00:01:00.000Z'),
          },
        },
        {
          bet: {
            id: 'bet-2',
            userId: 'user-2',
            walletId: 'wallet-2',
            raceId: 'race-1',
            currency: 'USD',
            betType: 'win',
            selectionId: 'horse-1',
            stakeMinor: 1200n,
            payoutMinor: 0n,
            status: 'settled',
            resultStatus: 'lost',
            placedAt: new Date('2026-03-22T00:00:00.000Z'),
            settledAt: new Date('2026-03-22T00:01:00.000Z'),
            refundedAt: null,
            metadata: {},
            createdAt: new Date('2026-03-22T00:00:00.000Z'),
            updatedAt: new Date('2026-03-22T00:01:00.000Z'),
          },
          ledgerEntry: null,
        },
      ],
    })),
  },
}))

vi.mock('../services/settlementService.js', () => ({
  getSettlementService: () => settlementServiceMock,
}))

import settlementRoutes from './settlementRoutes.js'

type EnvSnapshot = NodeJS.ProcessEnv

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/settlements', settlementRoutes)
  return app
}

let savedEnv: EnvSnapshot

beforeEach(() => {
  savedEnv = { ...process.env }
  process.env.REQUIRE_API_TOKEN = '0'
  delete process.env.API_TOKEN
  delete process.env.ADMIN_API_TOKEN
})

afterEach(() => {
  process.env = savedEnv
  vi.restoreAllMocks()
})

describe('settlementRoutes', () => {
  it('settles a finished race', async () => {
    const res = await request(makeApp()).post('/settlements/races/race-1')

    expect(res.status).toBe(201)
    expect(res.body.settlement.raceId).toBe('race-1')
    expect(res.body.settlement.totalPayoutMinor).toBe('2400')
    expect(res.body.settlement.settledBets).toHaveLength(2)
    expect(res.body.settlement.settledBets[0].ledgerEntry.deltaMinor).toBe('2400')
  })

  it('requires an admin token when configured', async () => {
    process.env.ADMIN_API_TOKEN = 'alpha-admin-token'

    const res = await request(makeApp()).post('/settlements/races/race-1')

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
  })

  it('maps settlement conflicts to 409', async () => {
    settlementServiceMock.settleRaceBets.mockRejectedValueOnce(
      new ConflictError('race is not ready for settlement'),
    )

    const res = await request(makeApp()).post('/settlements/races/race-1')

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'race is not ready for settlement' })
  })
})