import { randomUUID } from 'crypto'
import { getPool } from '../db/pool.js'
import { getBetRepository } from '../db/betRepository.js'
import { getRaceRepository } from '../db/raceRepository.js'
import { getWalletRepository } from '../db/walletRepository.js'
import { RaceState } from '../race/raceState.js'
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../user/errors.js'
import type { WalletLedgerEntryRecord, WalletRecord } from '../user/types.js'
import type { BetRecord, PlaceBetInput } from '../bet/types.js'
import { getUserService } from './userService.js'
import { applyWalletDeltaInTransaction } from './walletService.js'

export interface PlaceBetResult {
  bet: BetRecord
  wallet: WalletRecord
  ledgerEntry: WalletLedgerEntryRecord
}

export interface BetService {
  placeBet(input: PlaceBetInput): Promise<PlaceBetResult>
  getBetById(betId: string): Promise<BetRecord>
  listBetsByUserId(userId: string, limit?: number): Promise<BetRecord[]>
}

function normalizeCurrency(currency?: string): string {
  return (currency || 'USD').trim().toUpperCase()
}

function ensurePositiveStake(stakeMinor: bigint): void {
  if (stakeMinor <= 0n) {
    throw new ValidationError('stakeMinor must be greater than zero')
  }
}

function normalizeBetType(): 'win' {
  return 'win'
}

function assertRaceOpenAndSelectionValid(
  raceId: string,
  selectionId: string,
): void {
  const precomputed = RaceState.getPrecomputedRace()
  const phase = RaceState.getStateMachine().getPhaseAndSecond().phase

  if (!precomputed || precomputed.id !== raceId) {
    throw new ValidationError('race is not open for betting')
  }

  if (!['idle', 'countdown'].includes(phase)) {
    throw new ValidationError('race is closed for betting')
  }

  const validSelection = precomputed.horses.some((horse) => horse.id === selectionId)
  if (!validSelection) {
    throw new ValidationError('selection is not valid for race')
  }
}

export class DefaultBetService implements BetService {
  private betRepository = getBetRepository()
  private walletRepository = getWalletRepository()
  private raceRepository = getRaceRepository()
  private userService = getUserService()

  async placeBet(input: PlaceBetInput): Promise<PlaceBetResult> {
    ensurePositiveStake(input.stakeMinor)

    const eligibility = await this.userService.getBetEligibility(input.userId)
    if (!eligibility.allowed) {
      throw new ForbiddenError(
        `user is not eligible to bet: ${eligibility.reasons.join(', ')}`,
      )
    }

    assertRaceOpenAndSelectionValid(input.raceId, input.selectionId)

    const raceRecord = await this.raceRepository.findRaceById(input.raceId)
    if (!raceRecord || raceRecord.lifecycleStatus !== 'seeded') {
      throw new ValidationError('race is not open for betting')
    }

    const currency = normalizeCurrency(input.currency)
    const pool = getPool()
    const client = await pool.connect()

    try {
      await client.query('begin')

      const wallet = await this.walletRepository.findWalletByUserIdForUpdate(
        input.userId,
        currency,
        client,
      )
      if (!wallet) {
        throw new NotFoundError('wallet not found')
      }

      if (wallet.balanceMinor < input.stakeMinor) {
        throw new ValidationError('insufficient balance')
      }

      const bet = await this.betRepository.createBet(
        {
          id: randomUUID(),
          userId: input.userId,
          walletId: wallet.id,
          raceId: input.raceId,
          currency,
          betType: normalizeBetType(),
          selectionId: input.selectionId,
          stakeMinor: input.stakeMinor,
          payoutMinor: null,
          status: 'placed',
          resultStatus: 'pending',
          metadata: input.metadata ?? {},
        },
        client,
      )

      const adjusted = await applyWalletDeltaInTransaction(
        {
          userId: input.userId,
          amountMinor: -input.stakeMinor,
          currency,
          entryType: 'bet_stake',
          referenceType: 'bet',
          referenceId: bet.id,
          metadata: {
            raceId: bet.raceId,
            selectionId: bet.selectionId,
            betType: bet.betType,
            ...bet.metadata,
          },
        },
        client,
      )

      await client.query('commit')
      return {
        bet,
        wallet: adjusted.wallet,
        ledgerEntry: adjusted.ledgerEntry,
      }
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async getBetById(betId: string): Promise<BetRecord> {
    const bet = await this.betRepository.findBetById(betId)
    if (!bet) {
      throw new NotFoundError('bet not found')
    }
    return bet
  }

  async listBetsByUserId(userId: string, limit?: number): Promise<BetRecord[]> {
    return this.betRepository.listBetsByUserId(userId, limit)
  }
}

let sharedBetService: BetService | null = null

export function getBetService(): BetService {
  if (!sharedBetService) {
    sharedBetService = new DefaultBetService()
  }
  return sharedBetService
}