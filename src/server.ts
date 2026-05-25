import express from 'express'
import http from 'http'
import https from 'https'
import fs from 'fs'
import { RaceWebSocketServer } from './websocket/wsServer.js'
import { runRestartRecovery } from './recovery/restartRecovery.js'
import { startWatchdog, stopWatchdog } from './timeline/watchdog.js'
import { MasterTimeline } from './timeline/masterTimeline.js'
import { stop as stopEngine } from './race/engineLoop.js'
import { startCycleClock, stopCycleClock } from './race/cycleClock.js'
import raceRoutes from './api/raceRoutes.js'
import internalRaceAuthorityRoutes from './api/internalRaceAuthorityRoutes.js'
import raceDataPersistenceAdminRoutes from './api/raceDataPersistenceAdminRoutes.js'
import { startRaceAuthorityObservability } from './observability/raceAuthoritySummary.js'
import {
  EVENT_CATALOG,
  validateCatalogSymmetry,
} from './race/events/catalog.js'
import { startEdgeSubscriber } from './broadcast/edgeSubscriber.js'
import { startLeaderElection } from './leader/elector.js'
import { rateLimit } from './utils/rateLimit.js'
import helmet from 'helmet'
import { closePool, verifyPool } from './db/pool.js'
import {
  isSimulationMode,
  simulationModeStartupMessage,
} from './runtime/simulationMode.js'

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
app.use('/internal/race-authority', internalRaceAuthorityRoutes)
app.use('/admin', raceDataPersistenceAdminRoutes)

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() })
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

if (isSimulationMode()) {
  console.warn(simulationModeStartupMessage())
}

// Crash-safe restart recovery (idempotent)
runRestartRecovery()

// Start watchdog
startWatchdog()
startRaceAuthorityObservability()

// Start lifecycle driver (ticks RaceStateMachine; starts engine only during race_running)
startCycleClock()

async function startServer(): Promise<void> {
  try {
    await verifyPool()
  } catch (e) {
    console.error(`Database verification failed: ${String(e)}`)
    process.exit(1)
  }

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
    console.log(`WebSocket server ready`)
    console.log(`Engine loop started`)
  })
}

void startServer()

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
  stopCycleClock()
  stopEngine()
  MasterTimeline.shutdown()
  server.close(() => {
    void closePool().finally(() => {
      console.log('Server closed')
      process.exit(0)
    })
  })
})

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully')
  stopWatchdog()
  stopCycleClock()
  stopEngine()
  MasterTimeline.shutdown()
  server.close(() => {
    void closePool().finally(() => {
      console.log('Server closed')
      process.exit(0)
    })
  })
})
