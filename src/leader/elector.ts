import { createClient } from 'redis'
import { EventEmitter } from 'events'

export type LeaderRole = 'leader' | 'edge'

class LeaderElector extends EventEmitter {
  private nodeId: string
  private key: string
  private ttlSec: number
  private role: LeaderRole = 'edge'
  private redis: ReturnType<typeof createClient> | null = null

  constructor(nodeId: string, key: string, ttlSec: number) {
    super()
    this.nodeId = nodeId
    this.key = key
    this.ttlSec = ttlSec
  }

  async start(url: string): Promise<void> {
    const client = createClient({ url })
    this.redis = client
    await client.connect()
    setInterval(() => this.tryAcquire().catch(() => {}), 3000)
    setInterval(() => this.renewIfLeader().catch(() => {}), 5000)
  }

  private async tryAcquire(): Promise<void> {
    if (!this.redis) return
    try {
      const ok = await this.redis.set(this.key, this.nodeId, {
        NX: true,
        EX: this.ttlSec,
      })
      if (ok) {
        if (this.role !== 'leader') {
          this.role = 'leader'
          this.emit('role', this.role)
        }
      } else {
        const cur = await this.redis.get(this.key)
        if (cur !== this.nodeId && this.role !== 'edge') {
          this.role = 'edge'
          this.emit('role', this.role)
        }
      }
    } catch {
      // ignore
    }
  }

  private async renewIfLeader(): Promise<void> {
    if (!this.redis) return
    try {
      const cur = await this.redis.get(this.key)
      if (cur === this.nodeId) {
        await this.redis.expire(this.key, this.ttlSec)
        if (this.role !== 'leader') {
          this.role = 'leader'
          this.emit('role', this.role)
        }
      } else if (this.role !== 'edge') {
        this.role = 'edge'
        this.emit('role', this.role)
      }
    } catch {
      // ignore
    }
  }

  getRole(): LeaderRole {
    return this.role
  }
}

let elector: LeaderElector | null = null

export async function startLeaderElection(): Promise<LeaderElector> {
  const url = process.env.REDIS_URL || 'redis://localhost:6379'
  const key = process.env.LEADER_KEY || 'nines:leader'
  const ttlSec = Number(process.env.LEADER_TTL_SEC || 15)
  const nodeId = `${process.pid}-${Math.random().toString(36).slice(2)}`
  elector = new LeaderElector(nodeId, key, ttlSec)
  await elector.start(url)
  return elector
}

export function getLeaderRole(): LeaderRole {
  return elector?.getRole() || 'edge'
}
