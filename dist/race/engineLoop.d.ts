import { EventEmitter } from 'events';
export declare const TICK_RATE = 20;
export declare const TICK_INTERVAL = 50;
export declare const DRIFT_TOLERANCE = 5;
export declare const engineEvents: EventEmitter<[never]>;
export declare function start(): void;
export declare function stop(): void;
export declare function reset(): void;
export declare function isRunning(): boolean;
