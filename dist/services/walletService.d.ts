import type { PoolClient } from 'pg';
import type { WalletAdjustmentInput, WalletLedgerEntryRecord, WalletRecord } from '../user/types.js';
export interface WalletService {
    getWalletByUserId(userId: string, currency?: string): Promise<WalletRecord>;
    creditWallet(input: WalletAdjustmentInput): Promise<{
        wallet: WalletRecord;
        ledgerEntry: WalletLedgerEntryRecord;
    }>;
    debitWallet(input: WalletAdjustmentInput): Promise<{
        wallet: WalletRecord;
        ledgerEntry: WalletLedgerEntryRecord;
    }>;
}
export declare function applyWalletDeltaInTransaction(input: WalletAdjustmentInput, client: PoolClient): Promise<{
    wallet: WalletRecord;
    ledgerEntry: WalletLedgerEntryRecord;
}>;
export declare class DefaultWalletService implements WalletService {
    private walletRepository;
    private walletLedgerRepository;
    getWalletByUserId(userId: string, currency?: string): Promise<WalletRecord>;
    creditWallet(input: WalletAdjustmentInput): Promise<{
        wallet: WalletRecord;
        ledgerEntry: WalletLedgerEntryRecord;
    }>;
    debitWallet(input: WalletAdjustmentInput): Promise<{
        wallet: WalletRecord;
        ledgerEntry: WalletLedgerEntryRecord;
    }>;
    private applyDelta;
}
export declare function getWalletService(): WalletService;
