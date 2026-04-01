import { randomUUID } from 'crypto';
import { getPool } from '../db/pool.js';
import { getBetRepository } from '../db/betRepository.js';
import { getRaceRepository } from '../db/raceRepository.js';
import { getWalletRepository } from '../db/walletRepository.js';
import { RaceState } from '../race/raceState.js';
import { ForbiddenError, NotFoundError, ValidationError, } from '../user/errors.js';
import { getUserService } from './userService.js';
import { applyWalletDeltaInTransaction } from './walletService.js';
function normalizeCurrency(currency) {
    return (currency || 'USD').trim().toUpperCase();
}
function ensurePositiveStake(stakeMinor) {
    if (stakeMinor <= 0n) {
        throw new ValidationError('stakeMinor must be greater than zero');
    }
}
function normalizeBetType() {
    return 'win';
}
function assertRaceOpenAndSelectionValid(raceId, selectionId) {
    const precomputed = RaceState.getPrecomputedRace();
    const phase = RaceState.getStateMachine().getPhaseAndSecond().phase;
    if (!precomputed || precomputed.id !== raceId) {
        throw new ValidationError('race is not open for betting');
    }
    if (!['idle', 'countdown'].includes(phase)) {
        throw new ValidationError('race is closed for betting');
    }
    const validSelection = precomputed.horses.some((horse) => horse.id === selectionId);
    if (!validSelection) {
        throw new ValidationError('selection is not valid for race');
    }
}
export class DefaultBetService {
    betRepository = getBetRepository();
    walletRepository = getWalletRepository();
    raceRepository = getRaceRepository();
    userService = getUserService();
    async placeBet(input) {
        ensurePositiveStake(input.stakeMinor);
        const eligibility = await this.userService.getBetEligibility(input.userId);
        if (!eligibility.allowed) {
            throw new ForbiddenError(`user is not eligible to bet: ${eligibility.reasons.join(', ')}`);
        }
        assertRaceOpenAndSelectionValid(input.raceId, input.selectionId);
        const raceRecord = await this.raceRepository.findRaceById(input.raceId);
        if (!raceRecord || raceRecord.lifecycleStatus !== 'seeded') {
            throw new ValidationError('race is not open for betting');
        }
        const currency = normalizeCurrency(input.currency);
        const pool = getPool();
        const client = await pool.connect();
        try {
            await client.query('begin');
            const wallet = await this.walletRepository.findWalletByUserIdForUpdate(input.userId, currency, client);
            if (!wallet) {
                throw new NotFoundError('wallet not found');
            }
            if (wallet.balanceMinor < input.stakeMinor) {
                throw new ValidationError('insufficient balance');
            }
            const bet = await this.betRepository.createBet({
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
            }, client);
            const adjusted = await applyWalletDeltaInTransaction({
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
            }, client);
            await client.query('commit');
            return {
                bet,
                wallet: adjusted.wallet,
                ledgerEntry: adjusted.ledgerEntry,
            };
        }
        catch (error) {
            await client.query('rollback');
            throw error;
        }
        finally {
            client.release();
        }
    }
    async getBetById(betId) {
        const bet = await this.betRepository.findBetById(betId);
        if (!bet) {
            throw new NotFoundError('bet not found');
        }
        return bet;
    }
    async listBetsByUserId(userId, limit) {
        return this.betRepository.listBetsByUserId(userId, limit);
    }
}
let sharedBetService = null;
export function getBetService() {
    if (!sharedBetService) {
        sharedBetService = new DefaultBetService();
    }
    return sharedBetService;
}
