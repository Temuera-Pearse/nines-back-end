import { EventEmitter } from 'events'

export type BusHandler = (msg: Buffer) => void

export interface BroadcastBus {
  publish(topic: string, msg: Buffer): Promise<void>
  subscribe(topic: string, handler: BusHandler): Promise<void>
}

class InMemoryBus implements BroadcastBus {
  private ee = new EventEmitter()
  async publish(topic: string, msg: Buffer): Promise<void> {
    this.ee.emit(topic, msg)
  }
  async subscribe(topic: string, handler: BusHandler): Promise<void> {
    this.ee.on(topic, handler)
  }
}

let sharedBus: BroadcastBus | null = null

export function getBus(): BroadcastBus {
  if (sharedBus) return sharedBus
  const provider = (process.env.BUS_PROVIDER || 'memory').toLowerCase()
  if (provider === 'redis') {
    try {
      // lazy import to avoid hard dependency
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createClient } = require('redis')
      const client = createClient({ url: process.env.REDIS_URL })
      client.connect().catch(() => {})
      const redisBus: BroadcastBus = {
        async publish(topic, msg) {
          await client.publish(topic, msg.toString('base64'))
        },
        async subscribe(topic, handler) {
          const sub = client.duplicate()
          await sub.connect()
          await sub.subscribe(topic, (payload: string) =>
            handler(Buffer.from(payload, 'base64')),
          )
        },
      }
      sharedBus = redisBus
      return sharedBus
    } catch {
      // fallback
      sharedBus = new InMemoryBus()
      return sharedBus
    }
  }
  if (provider === 'nats') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { connect } = require('nats')
      const nc = connect({ servers: process.env.NATS_URL })
      const natsBus: BroadcastBus = {
        async publish(topic, msg) {
          ;(await nc).publish(topic, msg)
        },
        async subscribe(topic, handler) {
          const conn = await nc
          const sub = conn.subscribe(topic)
          ;(async () => {
            for await (const m of sub) {
              handler(Buffer.from(m.data))
            }
          })()
        },
      }
      sharedBus = natsBus
      return sharedBus
    } catch {
      sharedBus = new InMemoryBus()
      return sharedBus
    }
  }
  sharedBus = new InMemoryBus()
  return sharedBus
}
