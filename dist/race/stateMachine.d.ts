export type RacePhase = 'idle' | 'countdown' | 'race_starting' | 'race_running' | 'race_finished' | 'results_showing';
type Subscriber = (phase: RacePhase, second: number, data?: any) => void;
export declare class RaceStateMachine {
    state: RacePhase;
    private currentSecond;
    private lastProcessedUTCSec;
    private events;
    transition(next: RacePhase): void;
    is(state: RacePhase): boolean;
    subscribe(fn: Subscriber): () => void;
    tick(): void;
    getRemainingSecondsInState(): number;
    getPhaseAndSecond(): {
        phase: RacePhase;
        second: number;
    };
    private inRange;
}
export {};
