import { createClient } from 'redis';
import { EventEmitter } from 'events';
class LeaderElector extends EventEmitter {
    nodeId;
    key;
    ttlSec;
    role = 'edge';
    redis = null;
    constructor(nodeId, key, ttlSec) {
        super();
        this.nodeId = nodeId;
        this.key = key;
        this.ttlSec = ttlSec;
    }
    async start(url) {
        const client = createClient({ url });
        this.redis = client;
        await client.connect();
        setInterval(() => this.tryAcquire().catch(() => { }), 3000);
        setInterval(() => this.renewIfLeader().catch(() => { }), 5000);
    }
    async tryAcquire() {
        if (!this.redis)
            return;
        try {
            const ok = await this.redis.set(this.key, this.nodeId, {
                NX: true,
                EX: this.ttlSec,
            });
            if (ok) {
                if (this.role !== 'leader') {
                    this.role = 'leader';
                    this.emit('role', this.role);
                }
            }
            else {
                const cur = await this.redis.get(this.key);
                if (cur !== this.nodeId && this.role !== 'edge') {
                    this.role = 'edge';
                    this.emit('role', this.role);
                }
            }
        }
        catch {
            // ignore
        }
    }
    async renewIfLeader() {
        if (!this.redis)
            return;
        try {
            const cur = await this.redis.get(this.key);
            if (cur === this.nodeId) {
                await this.redis.expire(this.key, this.ttlSec);
                if (this.role !== 'leader') {
                    this.role = 'leader';
                    this.emit('role', this.role);
                }
            }
            else if (this.role !== 'edge') {
                this.role = 'edge';
                this.emit('role', this.role);
            }
        }
        catch {
            // ignore
        }
    }
    getRole() {
        return this.role;
    }
}
let elector = null;
export async function startLeaderElection() {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    const key = process.env.LEADER_KEY || 'nines:leader';
    const ttlSec = Number(process.env.LEADER_TTL_SEC || 15);
    const nodeId = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    elector = new LeaderElector(nodeId, key, ttlSec);
    await elector.start(url);
    return elector;
}
export function getLeaderRole() {
    return elector?.getRole() || 'edge';
}
