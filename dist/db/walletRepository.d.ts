import type { Pool, PoolClient } from 'pg';
import type { WalletRecord } from '../user/types.js';
type Queryable = Pool | PoolClient;
export interface CreateWalletInput {
    id: string;
    userId: string;
    currency: string;
    balanceMinor?: bigint;
}
export interface WalletRepository {
    createWallet(input: CreateWalletInput, queryable?: Queryable): Promise<WalletRecord>;
    findWalletByUserId(userId: string, currency?: string): Promise<WalletRecord | null>;
    findWalletById(walletId: string): Promise<WalletRecord | null>;
    findWalletByUserIdForUpdate(userId: string, currency: string, queryable: Queryable): Promise<WalletRecord | null>;
    updateBalanceMinor(walletId: string, balanceMinor: bigint, queryable: Queryable): Promise<WalletRecord>;
}
export declare class PgWalletRepository implements WalletRepository {
    createWallet(input: CreateWalletInput, queryable?: Queryable): Promise<WalletRecord>;
    findWalletByUserId(userId: string, currency?: string): Promise<WalletRecord | null>;
    findWalletById(walletId: string): Promise<WalletRecord | null>;
    findWalletByUserIdForUpdate(userId: string, currency: string, queryable: Queryable): Promise<WalletRecord | null>;
    updateBalanceMinor(walletId: string, balanceMinor: bigint, queryable: Queryable): Promise<WalletRecord>;
}
export declare function getWalletRepository(): WalletRepository;
export {};
