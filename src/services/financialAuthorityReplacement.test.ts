import type { Pool, PoolClient } from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BetRecord, CreateBetInput } from '../bet/types.js'
import type { BetRepository, MarkBetSettledInput } from '../db/betRepository.js'
import type { RaceRepository } from '../db/raceRepository.js'
import type { RaceRecord } from '../db/types.js'
import type { WalletRepository } from '../db/walletRepository.js'
import type {
  NinesFinancialClient,
  PlayerAccountSummary,
  PlayerBalance,
  SettleBetCommand,
  SettleBetResult,
} from '../financial/ninesFinancialClient.js'
import type {
  UserRecord,
  WalletLedgerEntryRecord,
  WalletRecord,
} from '../user/types.js'
import type { UserService } from './userService.js'

const raceStateMock = vi.hoisted(() => ({
  getPrecomputedRace: vi.fn(),
  getPhaseAndSecond: vi.fn(),
}))

vi.mock('../race/raceState.js', () => ({
  RaceState: {
    getPrecomputedRace: raceStateMock.getPrecomputedRace,
    getStateMachine: () => ({
      getPhaseAndSecond: raceStateMock.getPhaseAndSecond,
    }),
  },
}))

import {
  DefaultBetService,
  type BetServiceDependencies,
} from './betService.js'
import {
  DefaultSettlementService,
  type SettlementServiceDependencies,
} from './settlementService.js'

function makeWallet(overrides: Partial<WalletRecord> = {}): WalletRecord {
  const now = new Date('2026-03-22T00:00:00.000Z')
  return {
    id: 'wallet-1',
    userId: 'user-1',
    currency: 'USDC',
    balanceMinor: 5000n,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function makeLedgerEntry(
  overrides: Partial<WalletLedgerEntryRecord> = {},
): WalletLedgerEntryRecord {
  return {
    id: 1,
    walletId: 'wallet-1',
    entryType: 'bet_stake',
    deltaMinor: -1200n,
    balanceAfterMinor: 3800n,
    referenceType: 'bet',
    referenceId: 'bet-1',
    metadata: {},
    createdAt: new Date('2026-03-22T00:00:00.000Z'),
    ...overrides,
  }
}

function makeBet(overrides: Partial<BetRecord> = {}): BetRecord {
  const now = new Date('2026-03-22T00:00:00.000Z')
  return {
    id: 'bet-1',
    userId: 'user-1',
    walletId: 'wallet-1',
    raceId: 'race-1',
    currency: 'USDC',
    betType: 'win',
    selectionId: 'horse-3',
    stakeMinor: 1200n,
    payoutMinor: null,
    status: 'placed',
    resultStatus: 'pending',
    placedAt: now,
    settledAt: null,
    refundedAt: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function makeRace(overrides: Partial<RaceRecord> = {}): RaceRecord {
  const now = new Date('2026-03-22T00:00:00.000Z')
  return {
    raceId: 'race-1',
    seed: 'seed-race-1',
    lifecycleStatus: 'seeded',
    scheduledStartTime: null,
    actualStartTime: null,
    actualEndTime: null,
    checksum: null,
    winnerId: null,
    finishOrder: [],
    finishTimesMs: {},
    config: {},
    hasTickStream: false,
    hasPrecomputedPaths: false,
    eventsCount: 0,
    persistenceStatus: 'pending',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function createFakePool() {
  const query = vi.fn(async () => ({
    command: '',
    fields: [],
    oid: 0,
    rowCount: 0,
    rows: [],
  }))
  const release = vi.fn()
  const client = { query, release } as unknown as PoolClient
  const connect = vi.fn(async () => client)
  const pool = { connect } as unknown as Pool
  return { pool, connect, query, release }
}

function createBetRepository(
  overrides: Partial<BetRepository> = {},
): BetRepository {
  return {
    createBet: vi.fn(async (input: CreateBetInput) =>
      makeBet({
        id: input.id,
        userId: input.userId,
        walletId: input.walletId,
        raceId: input.raceId,
        currency: input.currency,
        betType: input.betType,
        selectionId: input.selectionId,
        stakeMinor: input.stakeMinor,
        payoutMinor: input.payoutMinor ?? null,
        status: input.status,
        resultStatus: input.resultStatus,
        metadata: input.metadata ?? {},
      }),
    ),
    findBetById: vi.fn(async () => null),
    listBetsByUserId: vi.fn(async () => []),
    listUnsettledBetsByRaceId: vi.fn(async () => []),
    markBetSettled: vi.fn(async (input: MarkBetSettledInput) =>
      makeBet({
        id: input.betId,
        payoutMinor: input.payoutMinor,
        status: input.status,
        resultStatus: input.resultStatus,
        settledAt: input.settledAt,
      }),
    ),
    markBetRefunded: vi.fn(async () => null),
    ...overrides,
  }
}

function createWalletRepository(
  overrides: Partial<WalletRepository> = {},
): WalletRepository {
  return {
    createWallet: vi.fn(async () => makeWallet()),
    findWalletByUserId: vi.fn(async () => makeWallet()),
    findWalletById: vi.fn(async () => makeWallet()),
    findWalletByUserIdForUpdate: vi.fn(async () => makeWallet()),
    updateBalanceMinor: vi.fn(async (_walletId: string, balanceMinor: bigint) =>
      makeWallet({ balanceMinor }),
    ),
    ...overrides,
  }
}

function createRaceRepository(
  race: RaceRecord,
  overrides: Partial<RaceRepository> = {},
): RaceRepository {
  return {
    upsertSeededRace: vi.fn(async () => undefined),
    markRaceStarted: vi.fn(async () => undefined),
    markRaceFinished: vi.fn(async () => undefined),
    markRaceArchived: vi.fn(async () => undefined),
    markPersistenceStatus: vi.fn(async () => undefined),
    findCurrentRace: vi.fn(async () => race),
    findPreviousRace: vi.fn(async () => null),
    listRaceHistory: vi.fn(async () => []),
    findRaceById: vi.fn(async () => race),
    ...overrides,
  }
}

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  const now = new Date('2026-03-22T00:00:00.000Z')
  return {
    id: 'user-1',
    username: 'player',
    email: null,
    accountStatus: 'active',
    dateOfBirth: '2000-01-01',
    ageVerificationStatus: 'self_attested',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function createUserService(overrides: Partial<UserService> = {}): UserService {
  return {
    createUser: vi.fn(async () => ({
      user: makeUser(),
      wallet: makeWallet(),
    })),
    getUserById: vi.fn(async () => makeUser()),
    updateAccountStatus: vi.fn(async () => makeUser()),
    updateAgeVerificationStatus: vi.fn(async () => makeUser()),
    getBetEligibility: vi.fn(async () => ({ allowed: true, reasons: [] })),
    ...overrides,
  }
}

function createFinancialClient(
  overrides: Partial<NinesFinancialClient> = {},
): NinesFinancialClient {
  return {
    reserveStake: vi.fn(async () => ({
      reservationId: 'reservation-1',
      acceptedAt: '2026-03-22T00:00:00.000Z',
    })),
    releaseReservation: vi.fn(async () => ({
      reservationId: 'reservation-1',
      releasedAt: '2026-03-22T00:00:00.000Z',
    })),
    settleBet: vi.fn(async (command: SettleBetCommand): Promise<SettleBetResult> => ({
      raceId: command.raceId,
      winningSelectionId: command.winningSelectionId,
      totalPoolMinor: command.totalPoolMinor,
      houseTakeMinor: '0',
      netPoolMinor: command.totalPoolMinor,
      roundingResidualMinor: '0',
      settledBets: command.acceptedBets.map((bet) => ({
        betId: bet.betId,
        userId: bet.userId,
        selectionId: bet.selectionId,
        resultStatus:
          bet.selectionId === command.winningSelectionId ? 'won' : 'lost',
        stakeMinor: bet.stakeMinor,
        payoutMinor:
          bet.selectionId === command.winningSelectionId
            ? command.totalPoolMinor
            : '0',
        captureTransactionId: `txn_capture_${bet.betId}`,
        payoutTransactionId:
          bet.selectionId === command.winningSelectionId
            ? `txn_payout_${bet.betId}`
            : null,
      })),
      settledAt: '2026-03-22T00:01:00.000Z',
    })),
    applyHouseTake: vi.fn(async () => ({
      raceId: 'race-1',
      amountMinor: '0',
      appliedAt: '2026-03-22T00:01:00.000Z',
    })),
    getPlayerBalance: vi.fn(async (): Promise<PlayerBalance> => ({
      playerAccountId: 'player-account-1',
      currency: 'USDC',
      spendableBalanceMinor: '5000',
      lockedBalanceMinor: '0',
      restrictedBalanceMinor: '0',
      displayBalanceMinor: '5000',
      asOf: '2026-03-22T00:00:00.000Z',
    })),
    getPlayerAccountSummary: vi.fn(async (): Promise<PlayerAccountSummary> => ({
      playerAccountId: 'player-account-1',
      userId: 'user-1',
      currency: 'USDC',
      effectiveStatus: 'active',
      displayBalanceMinor: '5000',
      spendableBalanceMinor: '5000',
      asOf: '2026-03-22T00:00:00.000Z',
    })),
    ...overrides,
  }
}

function failWalletDelta(): NonNullable<BetServiceDependencies['applyWalletDelta']> {
  return vi.fn(async () => {
    throw new Error('wallet mutation should not be called')
  }) as NonNullable<BetServiceDependencies['applyWalletDelta']>
}

beforeEach(() => {
  raceStateMock.getPrecomputedRace.mockReturnValue({
    id: 'race-1',
    horses: [{ id: 'horse-1' }, { id: 'horse-3' }],
  })
  raceStateMock.getPhaseAndSecond.mockReturnValue({ phase: 'idle' })
})

describe('financial authority replacement', () => {
  it('places bets through nines-financial stake reservations', async () => {
    const pool = createFakePool()
    const betRepository = createBetRepository()
    const walletRepository = createWalletRepository()
    const financialClient = createFinancialClient()
    const applyWalletDelta = failWalletDelta()
    const service = new DefaultBetService({
      betRepository,
      walletRepository,
      raceRepository: createRaceRepository(makeRace()),
      userService: createUserService(),
      financialClient,
      poolFactory: () => pool.pool,
      legacyAlphaFallbackEnabled: () => false,
      applyWalletDelta,
    })

    const result = await service.placeBet({
      userId: 'user-1',
      raceId: 'race-1',
      selectionId: 'horse-3',
      stakeMinor: 1200n,
      currency: 'USDC',
      idempotencyKey: 'reserve-key-1',
      metadata: { source: 'contract-test' },
    })

    expect(financialClient.reserveStake).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'reserve-key-1',
        userId: 'user-1',
        raceId: 'race-1',
        selectionId: 'horse-3',
        stakeMinor: '1200',
        currency: 'USDC',
      }),
    )
    expect(walletRepository.findWalletByUserId).toHaveBeenCalledWith(
      'user-1',
      'USDC',
    )
    expect(walletRepository.findWalletByUserIdForUpdate).not.toHaveBeenCalled()
    expect(walletRepository.updateBalanceMinor).not.toHaveBeenCalled()
    expect(applyWalletDelta).not.toHaveBeenCalled()
    expect(result.ledgerEntry).toBeNull()
    expect(result.financialReservation?.reservationId).toBe('reservation-1')
    expect(betRepository.createBet).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: 'USDC',
        metadata: expect.objectContaining({
          financialAuthority: 'nines-financial',
          financialReservationId: 'reservation-1',
        }),
      }),
      expect.any(Object),
    )
  })

  it('rejects bet acceptance when nines-financial rejects reservation', async () => {
    const pool = createFakePool()
    const betRepository = createBetRepository()
    const financialClient = createFinancialClient({
      reserveStake: vi.fn(async () => {
        throw new Error('reservation denied')
      }),
    })
    const service = new DefaultBetService({
      betRepository,
      walletRepository: createWalletRepository(),
      raceRepository: createRaceRepository(makeRace()),
      userService: createUserService(),
      financialClient,
      poolFactory: () => pool.pool,
      legacyAlphaFallbackEnabled: () => false,
      applyWalletDelta: failWalletDelta(),
    })

    await expect(
      service.placeBet({
        userId: 'user-1',
        raceId: 'race-1',
        selectionId: 'horse-3',
        stakeMinor: 1200n,
        currency: 'USDC',
      }),
    ).rejects.toThrow('reservation denied')

    expect(betRepository.createBet).not.toHaveBeenCalled()
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('settles bets by sending settlement instructions to nines-financial', async () => {
    const pool = createFakePool()
    const applyWalletDelta = vi.fn(async () => {
      throw new Error('wallet settlement should not be called')
    }) as NonNullable<SettlementServiceDependencies['applyWalletDelta']>
    const unsettledBets = [
      makeBet({ id: 'bet-win', userId: 'user-win', selectionId: 'horse-3' }),
      makeBet({
        id: 'bet-loss',
        userId: 'user-loss',
        walletId: 'wallet-2',
        selectionId: 'horse-1',
      }),
    ]
    const betRepository = createBetRepository({
      listUnsettledBetsByRaceId: vi.fn(async () => unsettledBets),
    })
    const financialClient = createFinancialClient({
      settleBet: vi.fn(async (command: SettleBetCommand): Promise<SettleBetResult> => ({
        raceId: command.raceId,
        winningSelectionId: command.winningSelectionId,
        totalPoolMinor: command.totalPoolMinor,
        houseTakeMinor: '0',
        netPoolMinor: command.totalPoolMinor,
        roundingResidualMinor: '0',
        settledBets: [
          {
            betId: 'bet-win',
            userId: 'user-win',
            selectionId: 'horse-3',
            resultStatus: 'won',
            stakeMinor: '1200',
            payoutMinor: '2400',
            captureTransactionId: 'txn_capture_bet_win',
            payoutTransactionId: 'txn_payout_bet_win',
          },
          {
            betId: 'bet-loss',
            userId: 'user-loss',
            selectionId: 'horse-1',
            resultStatus: 'lost',
            stakeMinor: '1200',
            payoutMinor: '0',
            captureTransactionId: 'txn_capture_bet_loss',
            payoutTransactionId: null,
          },
        ],
        settledAt: '2026-03-22T00:01:00.000Z',
      })),
    })
    const service = new DefaultSettlementService({
      betRepository,
      raceRepository: createRaceRepository(
        makeRace({
          lifecycleStatus: 'results_showing',
          winnerId: 'horse-3',
        }),
      ),
      financialClient,
      poolFactory: () => pool.pool,
      legacyAlphaFallbackEnabled: () => false,
      applyWalletDelta,
    })

    const result = await service.settleRaceBets('race-1')

    expect(financialClient.settleBet).toHaveBeenCalledTimes(1)
    expect(financialClient.settleBet).toHaveBeenCalledWith(
      {
        idempotencyKey: 'settle:race-1',
        correlationId: 'settlement:race-1',
        causationId: 'race:race-1:result',
        raceId: 'race-1',
        winningSelectionId: 'horse-3',
        acceptedBets: [
          {
            betId: 'bet-win',
            userId: 'user-win',
            selectionId: 'horse-3',
            stakeMinor: '1200',
          },
          {
            betId: 'bet-loss',
            userId: 'user-loss',
            selectionId: 'horse-1',
            stakeMinor: '1200',
          },
        ],
        totalPoolMinor: '2400',
        houseTakeBps: 0,
        currency: 'USDC',
      },
    )
    expect(betRepository.markBetSettled).toHaveBeenCalledTimes(2)
    expect(applyWalletDelta).not.toHaveBeenCalled()
    expect(result.processedCount).toBe(2)
    expect(result.wonCount).toBe(1)
    expect(result.lostCount).toBe(1)
    expect(result.totalPayoutMinor).toBe(2400n)
    expect(result.settledBets.every((entry) => entry.ledgerEntry === null)).toBe(
      true,
    )
  })

  it('keeps legacy alpha wallet mutation only behind the explicit fallback', async () => {
    const pool = createFakePool()
    const financialClient = createFinancialClient()
    const applyWalletDelta = vi.fn(async () => ({
      wallet: makeWallet({ balanceMinor: 3800n }),
      ledgerEntry: makeLedgerEntry({ entryType: 'bet_stake' }),
    })) as NonNullable<BetServiceDependencies['applyWalletDelta']>
    const service = new DefaultBetService({
      betRepository: createBetRepository(),
      walletRepository: createWalletRepository(),
      raceRepository: createRaceRepository(makeRace()),
      userService: createUserService(),
      financialClient,
      poolFactory: () => pool.pool,
      legacyAlphaFallbackEnabled: () => true,
      applyWalletDelta,
    })

    const result = await service.placeBet({
      userId: 'user-1',
      raceId: 'race-1',
      selectionId: 'horse-3',
      stakeMinor: 1200n,
      currency: 'USDC',
    })

    expect(financialClient.reserveStake).not.toHaveBeenCalled()
    expect(applyWalletDelta).toHaveBeenCalledWith(
      expect.objectContaining({
        amountMinor: -1200n,
        currency: 'USDC',
        entryType: 'bet_stake',
      }),
      expect.any(Object),
    )
    expect(result.ledgerEntry?.entryType).toBe('bet_stake')
    expect(result.financialReservation).toBeNull()
  })
})
