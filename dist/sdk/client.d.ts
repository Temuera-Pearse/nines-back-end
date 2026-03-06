export type ClientOptions = {
    url: string;
    binary?: boolean;
    mode?: 'plain' | 'delta';
    token?: string;
};
export type TickFrame = {
    type: 'race:tick' | 'race:keyframe' | 'race:delta';
    seq?: number;
    tickTs?: number;
    tickIndex?: number;
    protoVer?: number;
    data?: any;
    sig?: string;
    keyId?: string;
};
export declare class RaceClient {
    private ws;
    private opts;
    onFrame: ((f: TickFrame) => void) | null;
    constructor(opts: ClientOptions);
    connect(): void;
    requestSync(raceId: string, fromTick?: number): void;
}
