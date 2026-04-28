import type { Pool } from 'pg'
import { getPool } from '../db/pool.js'
import {
  getBetRepository,
  type BetRepository,
} from '../db/betRepository.js'
import {
  getRaceRepository,
  type RaceRepository,
} from '../db/raceRepository.js'
import { applyWalletDeltaInTransaction } from './walletService.js'
import {
  assertLegacyAlphaFinancialMutationPath,
  isLegacyAlphaFinancialFallbackEnabled,
  LEGACY_ALPHA_FINANCIAL_AUTHORITY_WARNING,
} from '../financial/legacyAlphaFinancialAuthority.js'
import {
  getNinesFinancialClient,
  type NinesFinancialClient,
} from '../financial/ninesFinancialClient.js'
import { ConflictError, NotFoundError } from '../user/errors.js'
import type { BetRecord } from '../bet/types.js'
import type {
  SettleRaceBetsResult,
  SettledBetRecord,
} from '../settlement/types.js'

const ALPHA_SETTLEMENT_HOUSE_TAKE_BPS = 0

export interface SettlementService {
  settleRaceBets(raceId: string): Promise<SettleRaceBetsResult>
}

function ensureRaceCanSettle(race: {
  lifecycleStatus: string
  winnerId: string | null
} | null): { winnerId: string } {
  if (!race) {
    throw new NotFoundError('race not found')
  }

  if (!['finished', 'results_showing', 'archived'].includes(race.lifecycleStatus)) {
    throw new ConflictError('race is not ready for settlement')
  }

  if (!race.winnerId) {
    throw new ConflictError('race results are not persisted yet')
  }

  return { winnerId: race.winnerId }
}

function calculatePayoutMinor(bet: BetRecord, winnerId: string): bigint {
  // TODO(phase-2.5): Alpha-only placeholder. Final payout truth belongs in
  // nines-financial settlement using accepted bets and settlement-stage pools.
  void LEGACY_ALPHA_FINANCIAL_AUTHORITY_WARNING
  if (bet.selectionId !== winnerId) return 0n
  return bet.stakeMinor * 2n
}

export interface SettlementServiceDependencies {
  betRepository?: BetRepository
  raceRepository?: RaceRepository
  financialClient?: NinesFinancialClient
  poolFactory?: () => Pool
  legacyAlphaFallbackEnabled?: () => boolean
  applyWalletDelta?: typeof applyWalletDeltaInTransaction
}

export class DefaultSettlementService implements SettlementService {
  private readonly betRepository: BetRepository
  private readonly raceRepository: RaceRepository
  private readonly financialClient: NinesFinancialClient
  private readonly poolFactory: () => Pool
  private readonly legacyAlphaFallbackEnabled: () => boolean
  private readonly applyWalletDelta: typeof applyWalletDeltaInTransaction

  constructor(dependencies: SettlementServiceDependencies = {}) {
    this.betRepository = dependencies.betRepository ?? getBetRepository()
    this.raceRepository = dependencies.raceRepository ?? getRaceRepository()
    this.financialClient =
      dependencies.financialClient ?? getNinesFinancialClient()
    this.poolFactory = dependencies.poolFactory ?? getPool
    this.legacyAlphaFallbackEnabled =
      dependencies.legacyAlphaFallbackEnabled ??
      isLegacyAlphaFinancialFallbackEnabled
    this.applyWalletDelta =
      dependencies.applyWalletDelta ?? applyWalletDeltaInTransaction
  }

  async settleRaceBets(raceId: string): Promise<SettleRaceBetsResult> {
    const race = await this.raceRepository.findRaceById(raceId)
    const { winnerId } = ensureRaceCanSettle(race)

    if (this.legacyAlphaFallbackEnabled()) {
      return this.settleRaceBetsViaLegacyAlphaMutation(raceId, winnerId)
    }

    const pool = this.poolFactory()
    const client = await pool.connect()
    const settledAt = new Date()

    try {
      await client.query('begin')
      const unsettledBets = await this.betRepository.listUnsettledBetsByRaceId(
        raceId,
        client,
      )

      if (unsettledBets.length === 0) {
        await client.query('commit')

        return {
          raceId,
          winnerId,
          settledAt,
          processedCount: 0,
          wonCount: 0,
          lostCount: 0,
          totalPayoutMinor: 0n,
          settledBets: [],
        }
      }

      const totalPoolMinor = unsettledBets.reduce(
        (sum, bet) => sum + bet.stakeMinor,
        0n,
      )
      const financialSettlement = await this.financialClient.settleBet({
        idempotencyKey: `settle:${raceId}`,
        correlationId: `settlement:${raceId}`,
        causationId: `race:${raceId}:result`,
        raceId,
        winningSelectionId: winnerId,
        acceptedBets: unsettledBets.map((bet) => ({
          betId: bet.id,
          userId: bet.userId,
          selectionId: bet.selectionId,
          stakeMinor: bet.stakeMinor.toString(),
        })),
        totalPoolMinor: totalPoolMinor.toString(),
        houseTakeBps: ALPHA_SETTLEMENT_HOUSE_TAKE_BPS,
        currency: 'USDC',
      })
      const financialResultByBetId = new Map(
        financialSettlement.settledBets.map((bet) => [bet.betId, bet]),
      )
      const settledBets: SettledBetRecord[] = []
      let wonCount = 0
      let lostCount = 0
      let totalPayoutMinor = 0n

      for (const bet of unsettledBets) {
        const financialResult = financialResultByBetId.get(bet.id)

        if (!financialResult) {
          throw new ConflictError(
            `nines-financial did not return settlement for bet: ${bet.id}`,
          )
        }

        const payoutMinor = BigInt(financialResult.payoutMinor)
        const resultStatus = financialResult.resultStatus

        if (resultStatus === 'won') {
          wonCount += 1
        } else if (resultStatus === 'lost') {
          lostCount += 1
        }

        totalPayoutMinor += payoutMinor

        const settledBet = await this.betRepository.markBetSettled(
          {
            betId: bet.id,
            payoutMinor,
            status: 'settled',
            resultStatus,
            settledAt,
          },
          client,
        )

        if (!settledBet) {
          throw new NotFoundError(`bet not found during settlement: ${bet.id}`)
        }

        settledBets.push({
          bet: settledBet,
          ledgerEntry: null,
        })
      }

      await client.query('commit')

      return {
        raceId,
        winnerId,
        settledAt,
        processedCount: settledBets.length,
        wonCount,
        lostCount,
        totalPayoutMinor,
        settledBets,
      }
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  private async settleRaceBetsViaLegacyAlphaMutation(
    raceId: string,
    winnerId: string,
  ): Promise<SettleRaceBetsResult> {
    assertLegacyAlphaFinancialMutationPath('DefaultSettlementService.settleRaceBets')
    void LEGACY_ALPHA_FINANCIAL_AUTHORITY_WARNING

    const pool = this.poolFactory()
    const client = await pool.connect()
    const settledAt = new Date()

    try {
      await client.query('begin')
      const unsettledBets = await this.betRepository.listUnsettledBetsByRaceId(
        raceId,
        client,
      )

      const settledBets: SettledBetRecord[] = []
      let wonCount = 0
      let lostCount = 0
      let totalPayoutMinor = 0n

      for (const bet of unsettledBets) {
        const payoutMinor = calculatePayoutMinor(bet, winnerId)
        const resultStatus = payoutMinor > 0n ? 'won' : 'lost'
        let ledgerEntry: SettledBetRecord['ledgerEntry'] = null

        if (payoutMinor > 0n) {
          const credited = await this.applyWalletDelta(
            {
              userId: bet.userId,
              amountMinor: payoutMinor,
              currency: bet.currency,
              entryType: 'settlement_credit',
              referenceType: 'bet',
              referenceId: bet.id,
              metadata: {
                raceId: bet.raceId,
                selectionId: bet.selectionId,
                winnerId,
                stakeMinor: bet.stakeMinor.toString(),
                payoutMinor: payoutMinor.toString(),
              },
            },
            client,
          )

          if (credited.wallet.id !== bet.walletId) {
            throw new ConflictError('bet wallet does not match credited wallet')
          }

          ledgerEntry = credited.ledgerEntry
          wonCount += 1
          totalPayoutMinor += payoutMinor
        } else {
          lostCount += 1
        }

        const settledBet = await this.betRepository.markBetSettled(
          {
            betId: bet.id,
            payoutMinor,
            status: 'settled',
            resultStatus,
            settledAt,
          },
          client,
        )

        if (!settledBet) {
          throw new NotFoundError(`bet not found during settlement: ${bet.id}`)
        }

        settledBets.push({
          bet: settledBet,
          ledgerEntry,
        })
      }

      await client.query('commit')

      return {
        raceId,
        winnerId,
        settledAt,
        processedCount: settledBets.length,
        wonCount,
        lostCount,
        totalPayoutMinor,
        settledBets,
      }
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }
}

let sharedSettlementService: SettlementService | null = null

export function getSettlementService(): SettlementService {
  if (!sharedSettlementService) {
    sharedSettlementService = new DefaultSettlementService()
  }
  return sharedSettlementService
}
