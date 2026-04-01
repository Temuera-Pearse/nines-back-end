import type { Pool, PoolClient } from 'pg';
import type { WalletLedgerEntryRecord, WalletLedgerEntryType } from '../user/types.js';
type Queryable = Pool | PoolClient;
export interface CreateWalletLedgerEntryInput {
    walletId: string;
    entryType: WalletLedgerEntryType;
    deltaMinor: bigint;
    balanceAfterMinor: bigint;
    referenceType?: string | null;
    referenceId?: string | null;
    metadata?: Record<string, unknown>;
}
export interface WalletLedgerRepository {
    createEntry(input: CreateWalletLedgerEntryInput, queryable: Queryable): Promise<WalletLedgerEntryRecord>;
    listEntriesByWalletId(walletId: string): Promise<WalletLedgerEntryRecord[]>;
}
export declare class PgWalletLedgerRepository implements WalletLedgerRepository {
    createEntry(input: CreateWalletLedgerEntryInput, queryable: Queryable): Promise<WalletLedgerEntryRecord>;
    listEntriesByWalletId(walletId: string): Promise<WalletLedgerEntryRecord[]>;
}
export declare function getWalletLedgerRepository(): WalletLedgerRepository;
export {};
