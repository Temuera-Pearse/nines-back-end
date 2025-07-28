import express from 'express'
import http from 'http'
import { RaceWebSocketServer } from './websocket/wsServer.js' // Updated import
import { RaceScheduler } from './race/raceScheduler.js'
import raceRoutes from './api/raceRoutes.js'

const app = express()
const PORT = process.env.PORT || 3001

// Middleware
app.use(express.json())

// Routes
app.use('/race', raceRoutes)

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() })
})

// Create HTTP server
const server = http.createServer(app)

// Initialize WebSocket server
RaceWebSocketServer.init(server) // Updated to use the new class name

// Start race scheduler
RaceScheduler.start()

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
  console.log(`WebSocket server ready`)
  console.log(`Race scheduler started`)
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully')
  RaceScheduler.stop()
  server.close(() => {
    console.log('Server closed')
    process.exit(0)
  })
})

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully')
  RaceScheduler.stop()
  server.close(() => {
    console.log('Server closed')
    process.exit(0)
  })
})
