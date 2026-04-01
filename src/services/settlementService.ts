import { getPool } from '../db/pool.js'
import { getBetRepository } from '../db/betRepository.js'
import { getRaceRepository } from '../db/raceRepository.js'
import { applyWalletDeltaInTransaction } from './walletService.js'
import { ConflictError, NotFoundError } from '../user/errors.js'
import type { BetRecord } from '../bet/types.js'
import type {
  SettleRaceBetsResult,
  SettledBetRecord,
} from '../settlement/types.js'

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
  if (bet.selectionId !== winnerId) return 0n
  return bet.stakeMinor * 2n
}

export class DefaultSettlementService implements SettlementService {
  private betRepository = getBetRepository()
  private raceRepository = getRaceRepository()

  async settleRaceBets(raceId: string): Promise<SettleRaceBetsResult> {
    const race = await this.raceRepository.findRaceById(raceId)
    const { winnerId } = ensureRaceCanSettle(race)

    const pool = getPool()
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
          const credited = await applyWalletDeltaInTransaction(
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