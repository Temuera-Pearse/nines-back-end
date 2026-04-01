import type { Pool, PoolClient } from 'pg';
import type { BetRecord, BetResultStatus, BetStatus, CreateBetInput } from '../bet/types.js';
type Queryable = Pool | PoolClient;
export interface MarkBetSettledInput {
    betId: string;
    payoutMinor: bigint;
    status: BetStatus;
    resultStatus: BetResultStatus;
    settledAt: Date;
}
export interface MarkBetRefundedInput {
    betId: string;
    status: BetStatus;
    resultStatus: BetResultStatus;
    refundedAt: Date;
}
export interface BetRepository {
    createBet(input: CreateBetInput, queryable: Queryable): Promise<BetRecord>;
    findBetById(betId: string): Promise<BetRecord | null>;
    listBetsByUserId(userId: string, limit?: number): Promise<BetRecord[]>;
    listUnsettledBetsByRaceId(raceId: string, queryable: Queryable): Promise<BetRecord[]>;
    markBetSettled(input: MarkBetSettledInput, queryable: Queryable): Promise<BetRecord | null>;
    markBetRefunded(input: MarkBetRefundedInput, queryable: Queryable): Promise<BetRecord | null>;
}
export declare class PgBetRepository implements BetRepository {
    createBet(input: CreateBetInput, queryable: Queryable): Promise<BetRecord>;
    findBetById(betId: string): Promise<BetRecord | null>;
    listBetsByUserId(userId: string, limit?: number): Promise<BetRecord[]>;
    listUnsettledBetsByRaceId(raceId: string, queryable: Queryable): Promise<BetRecord[]>;
    markBetSettled(input: MarkBetSettledInput, queryable: Queryable): Promise<BetRecord | null>;
    markBetRefunded(input: MarkBetRefundedInput, queryable: Queryable): Promise<BetRecord | null>;
}
export declare function getBetRepository(): BetRepository;
export {};
