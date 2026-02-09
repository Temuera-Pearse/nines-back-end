import { WebSocketServer, WebSocket } from 'ws'
import { RaceState } from '../race/raceState.js'
import { activeRaces } from '../race/activeRaceMemory.js'
import { engineMetrics } from '../metrics/engineMetrics.js'
import { getPublicKeyId, isSigningEnabled, signBytes } from '../utils/signer'
import { URL } from 'url'
import { getBus } from '../broadcast/bus.js'
import { getLeaderRole } from '../leader/elector.js'

const ts = () => new Date().toISOString()
const PROTO_VER = Number(process.env.PROTO_VER || 1)

// Catch-up window/rate limit constants
const MAX_CATCHUP_TICKS = 50
const DEFAULT_CATCHUP_TICKS = 10
const SYNC_COOLDOWN_MS = 2000

// Backpressure + keepalive config
const WS_BACKPRESSURE_THRESHOLD = Number(
  process.env.WS_BACKPRESSURE_THRESHOLD || 1_000_000,
) // bytes
const WS_PING_INTERVAL_MS = Number(process.env.WS_PING_INTERVAL_MS || 30_000)
const LOG_VERBOSE = process.env.LOG_VERBOSE === '1'

// Keyframe cadence (ticks)
const KEYFRAME_INTERVAL_TICKS = Number(
  process.env.KEYFRAME_INTERVAL_TICKS || 20,
)

// Per-client last sync timestamp
const lastSyncByClient = new WeakMap<WebSocket, number>()

// Per-client preferences and liveness
type ClientPrefs = { binary: boolean; mode: 'plain' | 'delta' }
const clientPrefs = new WeakMap<WebSocket, ClientPrefs>()
const clientAlive = new WeakMap<WebSocket, boolean>()

// Per-race sequencing
const seqByRace = new Map<string, number>()
const lastKeyframeTickByRace = new Map<string, number>()
const lastPositionsByRace = new Map<string, number[]>()

// Utility: compute currentTickIndex for a race based on startTime and snapshot length
function getCurrentTickIndex(raceId: string): number {
  const rec = activeRaces.get(raceId)
  if (!rec) return -1
  return typeof rec.currentTickIndex === 'number' ? rec.currentTickIndex : -1
}

// Handle sync requests from clients
function handleSyncRequest(ws: WebSocket, msg: any) {
  const now = Date.now()
  const last = lastSyncByClient.get(ws) ?? 0
  if (now - last < SYNC_COOLDOWN_MS) {
    // rate-limited
    return
  }
  lastSyncByClient.set(ws, now)

  const raceId: string | undefined = msg?.raceId
  if (!raceId || !activeRaces.has(raceId)) {
    ws.send(JSON.stringify({ type: 'error', message: 'invalid raceId' }))
    return
  }
  const currentTickIndex = getCurrentTickIndex(raceId)
  const rec = activeRaces.get(raceId)!
  const fromTick: number | undefined =
    typeof msg?.fromTick === 'number' ? msg.fromTick : undefined

  let startIndex: number
  if (typeof fromTick === 'number') {
    const minAllowed = Math.max(0, currentTickIndex - MAX_CATCHUP_TICKS)
    startIndex = Math.max(minAllowed, Math.min(fromTick, currentTickIndex))
  } else {
    startIndex = Math.max(0, currentTickIndex - DEFAULT_CATCHUP_TICKS)
  }

  const ticksWindow = rec.ticks.slice(startIndex, currentTickIndex + 1)

  ws.send(
    JSON.stringify({
      type: 'race:catchup',
      raceId,
      startIndex,
      ticks: ticksWindow,
      currentTickIndex,
    }),
  )
  ws.send(
    JSON.stringify({
      type: 'race:sync-complete',
      raceId,
      currentTickIndex,
    }),
  )
}

/**
 * WebSocket server for real-time race updates
 */
export class RaceWebSocketServer {
  private static wss: WebSocketServer
  private static clients: Set<WebSocket> = new Set()
  private static droppedTickFrames = 0
  private static bufferedAmountRing: number[] = []
  private static bufferedAmountRingCap = 200
  private static role: 'leader' | 'edge' = 'edge'

  static init(server: any): void {
    this.wss = new WebSocketServer({ server })

    this.wss.on('connection', (ws: WebSocket, req) => {
      this.clients.add(ws)
      engineMetrics.setClientCount(this.clients.size)
      if (LOG_VERBOSE) {
        console.log(
          `[${ts()}][WS] Client connected. Total clients=${this.clients.size}`,
        )
      }

      // Parse client preferences from query string
      try {
        const url = new URL(req?.url || '/', 'http://localhost')
        if (process.env.REQUIRE_TOKEN === '1') {
          const tok = url.searchParams.get('token')
          const expected = process.env.BROADCAST_TOKEN || ''
          if (!tok || tok !== expected) {
            try {
              ws.close(1008, 'unauthorized')
            } catch {}
            this.clients.delete(ws)
            engineMetrics.setClientCount(this.clients.size)
            return
          }
        }
        const binary = url.searchParams.get('binary') === '1'
        const modeParam = url.searchParams.get('mode')
        const mode: 'plain' | 'delta' =
          modeParam === 'delta' ? 'delta' : 'plain'
        clientPrefs.set(ws, { binary, mode })
      } catch {
        clientPrefs.set(ws, { binary: false, mode: 'plain' })
      }

      // keepalive
      clientAlive.set(ws, true)
      ws.on('pong', () => clientAlive.set(ws, true))

      // On connect: only provide basic race info; client requests catch-up
      const pre = RaceState.getPrecomputedRace()
      if (pre?.id) {
        const currentTickIndex = activeRaces.has(pre.id)
          ? getCurrentTickIndex(pre.id)
          : -1
        ws.send(
          JSON.stringify({
            type: 'race:info',
            raceId: pre.id,
            config: pre.config,
            currentTickIndex,
          }),
        )
      }

      ws.on('message', (data) => {
        let msg: any
        try {
          msg = JSON.parse(String(data))
        } catch {
          return
        }
        if (msg?.type === 'sync:request') {
          handleSyncRequest(ws, msg)
        }
      })

      ws.on('close', () => {
        this.clients.delete(ws)
        engineMetrics.setClientCount(this.clients.size)
        if (LOG_VERBOSE) {
          console.log(
            `[${ts()}][WS] Client disconnected. Total clients=${
              this.clients.size
            }`,
          )
        }
      })
      ws.on('error', (err) => {
        this.clients.delete(ws)
        engineMetrics.setClientCount(this.clients.size)
        console.warn(`[${ts()}][WS] Client error: ${String(err)}`)
      })
    })

    console.log(`[${ts()}][WS] WebSocket server initialized`)

    // Ping/pong keepalive
    setInterval(() => {
      for (const ws of this.clients) {
        const alive = clientAlive.get(ws)
        if (alive === false) {
          try {
            ws.terminate()
          } catch {}
          this.clients.delete(ws)
          engineMetrics.setClientCount(this.clients.size)
          continue
        }
        clientAlive.set(ws, false)
        try {
          ws.ping()
        } catch {}
      }
    }, WS_PING_INTERVAL_MS)
  }

  static setRole(role: 'leader' | 'edge'): void {
    this.role = role
  }

  static broadcast(message: any): void {
    const type = message?.type ?? 'unknown'
    const raceId =
      message?.data?.raceId ??
      (Array.isArray(message?.data) ? undefined : message?.data?.id)
    if (LOG_VERBOSE) {
      console.log(
        `[${ts()}][WS] Broadcast ${type}${raceId ? ` [${raceId}]` : ''} to ${
          this.clients.size
        } clients`,
      )
    }

    // Attach sequencing + timestamp for tick frames (leader only)
    let payloadObj: any = message
    let tickIndex: number | undefined = undefined
    const nowMs = Date.now()
    const role = this.role || getLeaderRole()
    const isLeader = role === 'leader'
    if (isLeader && type === 'race:tick' && raceId) {
      const currentSeq = (seqByRace.get(raceId) || 0) + 1
      seqByRace.set(raceId, currentSeq)
      if (typeof message?.data?.tickIndex === 'number') {
        tickIndex = message.data.tickIndex as number
      }
      payloadObj = {
        ...message,
        seq: currentSeq,
        tickTs: nowMs,
        protoVer: PROTO_VER,
      }
      engineMetrics.setLatestSeq(raceId, currentSeq)
    }

    // Serialize (without signature) for signing + size
    let payloadJson = ''
    try {
      payloadJson = JSON.stringify(payloadObj)
    } catch {
      payloadJson = JSON.stringify({ type })
    }

    // Optional signing (leader only)
    if (isLeader && type === 'race:tick' && isSigningEnabled()) {
      try {
        const sig = signBytes(Buffer.from(payloadJson))
        payloadObj = { ...payloadObj, sig, keyId: getPublicKeyId() }
        payloadJson = JSON.stringify(payloadObj)
      } catch {}
    }

    // Broadcast with backpressure skip for ticks
    for (const client of this.clients) {
      if (client.readyState !== 1) continue
      const prefs = clientPrefs.get(client) || { binary: false, mode: 'plain' }
      const bufAmt = (client as any).bufferedAmount || 0
      this.bufferedAmountRing.push(bufAmt)
      if (this.bufferedAmountRing.length > this.bufferedAmountRingCap) {
        this.bufferedAmountRing.shift()
      }
      engineMetrics.recordBufferedAmount(bufAmt)

      if (type === 'race:tick' && bufAmt > WS_BACKPRESSURE_THRESHOLD) {
        // Protect loop: skip tick frame for this client
        this.droppedTickFrames++
        engineMetrics.incDroppedTickFrames()
        continue
      }

      if (prefs.binary && type === 'race:tick') {
        // Experimental binary: send positions as Float32Array if present
        const positions: number[] | undefined = payloadObj?.data?.positions
        if (Array.isArray(positions)) {
          const header = Buffer.from(
            JSON.stringify({
              type,
              seq: payloadObj.seq,
              tickTs: payloadObj.tickTs,
              tickIndex,
              protoVer: PROTO_VER,
            }),
          )
          const arr = new Float32Array(positions)
          const body = Buffer.from(arr.buffer)
          const out = Buffer.concat([header, Buffer.from('\n'), body])
          try {
            client.send(out, { binary: true })
          } catch {}
          continue
        }
      }

      // Optional delta mode for JSON clients
      if (!prefs.binary && prefs.mode === 'delta' && type === 'race:tick') {
        const positions: number[] | undefined = payloadObj?.data?.positions
        if (
          Array.isArray(positions) &&
          typeof tickIndex === 'number' &&
          raceId
        ) {
          const lastKeyTick = lastKeyframeTickByRace.get(raceId) || -Infinity
          const needKeyframe =
            !Number.isFinite(lastKeyTick) ||
            tickIndex - lastKeyTick >= KEYFRAME_INTERVAL_TICKS
          if (needKeyframe) {
            lastKeyframeTickByRace.set(raceId, tickIndex)
            lastPositionsByRace.set(raceId, positions.slice())
            const keyframeMsg = { ...payloadObj, type: 'race:keyframe' }
            try {
              client.send(JSON.stringify(keyframeMsg))
            } catch {}
            continue
          } else {
            const lastPos = lastPositionsByRace.get(raceId)
            if (Array.isArray(lastPos) && lastPos.length === positions.length) {
              const deltas = positions.map((p, i) => p - lastPos[i])
              // update last positions
              lastPositionsByRace.set(raceId, positions.slice())
              const deltaMsg = {
                ...payloadObj,
                type: 'race:delta',
                data: { ...payloadObj.data, deltas },
              }
              try {
                client.send(JSON.stringify(deltaMsg))
              } catch {}
              continue
            }
          }
        }
      }

      try {
        client.send(payloadJson)
      } catch {}
    }

    // Optional bus publish (SOT fan-out) leader only
    try {
      if (
        isLeader &&
        raceId &&
        (type === 'race:tick' ||
          type === 'race:keyframe' ||
          type === 'race:delta')
      ) {
        const topic = `race.${raceId}`
        getBus()
          .publish(topic, Buffer.from(payloadJson))
          .catch(() => {})
      }
    } catch {}
  }
}
