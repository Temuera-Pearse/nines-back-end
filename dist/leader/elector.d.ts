import { EventEmitter } from 'events';
export type LeaderRole = 'leader' | 'edge';
declare class LeaderElector extends EventEmitter {
    private nodeId;
    private key;
    private ttlSec;
    private role;
    private redis;
    constructor(nodeId: string, key: string, ttlSec: number);
    start(url: string): Promise<void>;
    private tryAcquire;
    private renewIfLeader;
    getRole(): LeaderRole;
}
export declare function startLeaderElection(): Promise<LeaderElector>;
export declare function getLeaderRole(): LeaderRole;
export {};
