import { getBus } from './bus.js'
import { RaceWebSocketServer } from '../websocket/wsServer.js'

export async function startEdgeSubscriber(): Promise<void> {
  const topicPrefix = 'race.'
  // For simplicity, subscribe to a wildcard of all races if bus supports it; otherwise, list of known topics.
  // InMemory/Redis simple subscribe per race would require IDs; here we demonstrate a generic approach.
  // If BUS_SUBSCRIBE_RACE_ID is provided, subscribe only to that race.
  const raceId = process.env.BUS_SUBSCRIBE_RACE_ID
  const bus = getBus()
  const handler = (msg: Buffer) => {
    try {
      const obj = JSON.parse(msg.toString('utf8'))
      RaceWebSocketServer.broadcast(obj)
    } catch {
      // ignore
    }
  }
  if (raceId) {
    await bus.subscribe(`${topicPrefix}${raceId}`, handler)
  } else {
    // If bus provider supports pattern subscription, use env BUS_PATTERN_SUBSCRIBE
    const pattern = process.env.BUS_PATTERN_SUBSCRIBE
    if (pattern) {
      await bus.subscribe(pattern, handler)
    }
    // Otherwise, no-op; require explicit race id subscription
  }
}
