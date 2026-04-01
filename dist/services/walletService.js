import { getPool } from '../db/pool.js';
import { getWalletLedgerRepository } from '../db/walletLedgerRepository.js';
import { getWalletRepository } from '../db/walletRepository.js';
import { NotFoundError, ValidationError } from '../user/errors.js';
function normalizeCurrency(currency) {
    return (currency || 'USD').trim().toUpperCase();
}
function ensurePositiveAmount(amountMinor) {
    if (amountMinor <= 0n) {
        throw new ValidationError('amountMinor must be greater than zero');
    }
}
export async function applyWalletDeltaInTransaction(input, client) {
    const walletRepository = getWalletRepository();
    const walletLedgerRepository = getWalletLedgerRepository();
    const currency = normalizeCurrency(input.currency);
    const wallet = await walletRepository.findWalletByUserIdForUpdate(input.userId, currency, client);
    if (!wallet) {
        throw new NotFoundError('wallet not found');
    }
    const nextBalance = wallet.balanceMinor + input.amountMinor;
    if (nextBalance < 0n) {
        throw new ValidationError('insufficient balance');
    }
    const updatedWallet = await walletRepository.updateBalanceMinor(wallet.id, nextBalance, client);
    const ledgerEntry = await walletLedgerRepository.createEntry({
        walletId: wallet.id,
        entryType: input.entryType,
        deltaMinor: input.amountMinor,
        balanceAfterMinor: nextBalance,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        metadata: input.metadata ?? {},
    }, client);
    return { wallet: updatedWallet, ledgerEntry };
}
export class DefaultWalletService {
    walletRepository = getWalletRepository();
    walletLedgerRepository = getWalletLedgerRepository();
    async getWalletByUserId(userId, currency) {
        const wallet = await this.walletRepository.findWalletByUserId(userId, normalizeCurrency(currency));
        if (!wallet) {
            throw new NotFoundError('wallet not found');
        }
        return wallet;
    }
    async creditWallet(input) {
        ensurePositiveAmount(input.amountMinor);
        return this.applyDelta({ ...input, amountMinor: input.amountMinor });
    }
    async debitWallet(input) {
        ensurePositiveAmount(input.amountMinor);
        return this.applyDelta({ ...input, amountMinor: -input.amountMinor });
    }
    async applyDelta(input) {
        const pool = getPool();
        const client = await pool.connect();
        try {
            await client.query('begin');
            const adjusted = await applyWalletDeltaInTransaction(input, client);
            await client.query('commit');
            return adjusted;
        }
        catch (error) {
            await client.query('rollback');
            throw error;
        }
        finally {
            client.release();
        }
    }
}
let sharedWalletService = null;
export function getWalletService() {
    if (!sharedWalletService) {
        sharedWalletService = new DefaultWalletService();
    }
    return sharedWalletService;
}
