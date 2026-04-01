import type { WalletLedgerEntryRecord, WalletRecord } from '../user/types.js';
import type { BetRecord, PlaceBetInput } from '../bet/types.js';
export interface PlaceBetResult {
    bet: BetRecord;
    wallet: WalletRecord;
    ledgerEntry: WalletLedgerEntryRecord;
}
export interface BetService {
    placeBet(input: PlaceBetInput): Promise<PlaceBetResult>;
    getBetById(betId: string): Promise<BetRecord>;
    listBetsByUserId(userId: string, limit?: number): Promise<BetRecord[]>;
}
export declare class DefaultBetService implements BetService {
    private betRepository;
    private walletRepository;
    private raceRepository;
    private userService;
    placeBet(input: PlaceBetInput): Promise<PlaceBetResult>;
    getBetById(betId: string): Promise<BetRecord>;
    listBetsByUserId(userId: string, limit?: number): Promise<BetRecord[]>;
}
export declare function getBetService(): BetService;
