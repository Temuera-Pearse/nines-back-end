export type BusHandler = (msg: Buffer) => void;
export interface BroadcastBus {
    publish(topic: string, msg: Buffer): Promise<void>;
    subscribe(topic: string, handler: BusHandler): Promise<void>;
}
export declare function getBus(): BroadcastBus;
