import { WebSocketServer, WebSocket } from 'ws'
import { RaceState } from '../race/raceState.js'

const ts = () => new Date().toISOString()

/**
 * WebSocket server for real-time race updates
 */
export class RaceWebSocketServer {
  // Renamed to avoid conflict with imported WebSocketServer
  private static wss: WebSocketServer // Updated type
  private static clients: Set<WebSocket> = new Set()

  /**
   * Initialize the WebSocket server
   */
  static init(server: any): void {
    this.wss = new WebSocketServer({ server }) // Now correctly uses the imported WebSocketServer

    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws)
      console.log(
        `[${ts()}][WS] Client connected. Total clients=${this.clients.size}`
      )

      // Late joiner handling: send seed/config and last few ticks
      const pre = RaceState.getPrecomputedRace()
      if (pre?.startTime) {
        ws.send(
          JSON.stringify({
            type: 'race:seed',
            data: {
              raceId: pre.id,
              config: pre.config,
              finishLine: pre.finishLine,
              horses: pre.horses,
              startTime: pre.startTime,
            },
          })
        )
        // Send last 10 ticks as catch-up
        const lastTicks = pre.ticks.slice(-10)
        if (lastTicks.length) {
          ws.send(JSON.stringify({ type: 'race:catchup', data: lastTicks }))
          console.warn(
            `[${ts()}][SYNC][${pre.id}] Client joined late, sending ${
              lastTicks.length
            } missed ticks`
          )
        }
      }

      ws.on('close', () => {
        this.clients.delete(ws)
        console.log(
          `[${ts()}][WS] Client disconnected. Total clients=${
            this.clients.size
          }`
        )
      })
      ws.on('error', (err) => {
        this.clients.delete(ws)
        console.warn(`[${ts()}][WS] Client error: ${String(err)}`)
      })
    })

    console.log(`[${ts()}][WS] WebSocket server initialized`)
  }

  /**
   * Broadcast a message to all connected clients
   */
  static broadcast(message: any): void {
    const type = message?.type ?? 'unknown'
    const raceId =
      message?.data?.raceId ??
      (Array.isArray(message?.data) ? undefined : message?.data?.id)
    console.log(
      `[${ts()}][WS] Broadcast ${type}${raceId ? ` [${raceId}]` : ''} to ${
        this.clients.size
      } clients`
    )
    const payload = JSON.stringify(message)
    for (const client of this.clients) {
      if (client.readyState === 1) {
        client.send(payload)
      }
    }
  }
}
