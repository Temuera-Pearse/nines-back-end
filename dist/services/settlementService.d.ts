import type { SettleRaceBetsResult } from '../settlement/types.js';
export interface SettlementService {
    settleRaceBets(raceId: string): Promise<SettleRaceBetsResult>;
}
export declare class DefaultSettlementService implements SettlementService {
    private betRepository;
    private raceRepository;
    settleRaceBets(raceId: string): Promise<SettleRaceBetsResult>;
}
export declare function getSettlementService(): SettlementService;
