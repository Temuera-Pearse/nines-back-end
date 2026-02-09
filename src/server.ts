import express from 'express'
import http from 'http'
import https from 'https'
import fs from 'fs'
import { RaceWebSocketServer } from './websocket/wsServer.js'
import { runRestartRecovery } from './recovery/restartRecovery.js'
import { startWatchdog, stopWatchdog } from './timeline/watchdog.js'
import { MasterTimeline } from './timeline/masterTimeline.js'
import { start as startEngine, stop as stopEngine } from './race/engineLoop.js'
import raceRoutes from './api/raceRoutes.js'
import { engineMetrics } from './metrics/engineMetrics.js'
import {
  EVENT_CATALOG,
  validateCatalogSymmetry,
} from './race/events/catalog.js'
import { startEdgeSubscriber } from './broadcast/edgeSubscriber.js'
import client from 'prom-client'
import { startLeaderElection } from './leader/elector.js'
import { rateLimit } from './utils/rateLimit.js'
import { initCloudWatch, pushMetrics } from './metrics/cloudwatch.js'
import helmet from 'helmet'

const app = express()
const PORT = process.env.PORT || 3001

// Middleware
app.use(express.json())
app.use(
  helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: false,
  }),
)
// Basic API rate limit (optional)
app.use(rateLimit({ windowMs: 10000, max: 200 }))

// Routes
app.use('/race', raceRoutes)

// Prometheus metrics
const collectDefaultMetrics = client.collectDefaultMetrics
collectDefaultMetrics({ prefix: 'nines_' })
const gaugeClients = new client.Gauge({
  name: 'nines_ws_clients',
  help: 'Current websocket clients',
})
const gaugeDropped = new client.Gauge({
  name: 'nines_ws_dropped_tick_frames',
  help: 'Dropped tick frames due to backpressure',
})
const gaugeBufferedAvg = new client.Gauge({
  name: 'nines_ws_buffered_amount_avg',
  help: 'Average bufferedAmount over recent window',
})
const gaugeTickRate = new client.Gauge({
  name: 'nines_tick_rate',
  help: 'Tick rate (ticks/sec) recent window',
})
app.get('/metrics', async (_req, res) => {
  try {
    const m = engineMetrics.getMetrics()
    gaugeClients.set(m.ws.clientCount)
    gaugeDropped.set(m.ws.droppedTickFrames)
    gaugeBufferedAvg.set(m.ws.avgBufferedAmount)
    gaugeTickRate.set(m.tickRate)
    // Optional CloudWatch push
    pushMetrics([
      { name: 'ws_clients', value: m.ws.clientCount },
      { name: 'ws_dropped_tick_frames', value: m.ws.droppedTickFrames },
      { name: 'ws_buffered_amount_avg', value: m.ws.avgBufferedAmount },
      { name: 'tick_rate', value: m.tickRate },
    ])
    res.set('Content-Type', client.register.contentType)
    res.end(await client.register.metrics())
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) })
  }
})

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() })
})

// Metrics snapshot
app.get('/race/metrics', (req, res) => {
  try {
    res.json(engineMetrics.getMetrics())
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

// Create server (HTTPS if certs configured)
let server: http.Server | https.Server
const TLS_KEY_PATH = process.env.TLS_KEY_PATH
const TLS_CERT_PATH = process.env.TLS_CERT_PATH
if (TLS_KEY_PATH && TLS_CERT_PATH) {
  try {
    const key = fs.readFileSync(TLS_KEY_PATH)
    const cert = fs.readFileSync(TLS_CERT_PATH)
    server = https.createServer({ key, cert }, app)
    console.log('HTTPS enabled')
  } catch (e) {
    console.warn(`HTTPS setup failed, falling back to HTTP: ${String(e)}`)
    server = http.createServer(app)
  }
} else {
  server = http.createServer(app)
}

// Initialize WebSocket server
RaceWebSocketServer.init(server)

// Optional edge subscriber (fan-in from bus)
if (process.env.EDGE_SUBSCRIBER === '1') {
  startEdgeSubscriber().catch((e) =>
    console.warn(`Edge subscriber failed to start: ${String(e)}`),
  )
}

// Validate event catalog symmetry for conflicts (warning-only)
const asym = validateCatalogSymmetry(EVENT_CATALOG)
if (asym.length > 0) {
  console.warn(`Event catalog asymmetry detected: ${JSON.stringify(asym)}`)
}

// Crash-safe restart recovery (idempotent)
runRestartRecovery()

// Start watchdog
startWatchdog()

// Start engine loop (20Hz)
startEngine()

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
  console.log(`WebSocket server ready`)
  console.log(`Engine loop started`)
  initCloudWatch()
})

// Leader election using Redis (optional)
if (process.env.LEADER_ELECTION === '1') {
  startLeaderElection()
    .then((elector) => {
      const role = elector.getRole()
      RaceWebSocketServer.setRole(role)
      elector.on('role', (r) => RaceWebSocketServer.setRole(r))
    })
    .catch((e) => console.warn(`Leader election failed to start: ${String(e)}`))
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully')
  stopWatchdog()
  stopEngine()
  MasterTimeline.shutdown()
  server.close(() => {
    console.log('Server closed')
    process.exit(0)
  })
})

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully')
  stopWatchdog()
  stopEngine()
  MasterTimeline.shutdown()
  server.close(() => {
    console.log('Server closed')
    process.exit(0)
  })
})
