import { Worker } from 'worker_threads'

const WS_URL = process.env.WS_URL || 'ws://localhost:3001'
const TOTAL = Number(process.env.CLIENTS || 20000)
const PER_WORKER = Number(process.env.PER_WORKER || 2000)
const MODE = process.env.MODE === 'delta' ? 'delta' : 'plain'
const BINARY = process.env.BINARY === '1'
const TOKEN = process.env.BROADCAST_TOKEN || ''

const workers: Worker[] = []
const count = Math.ceil(TOTAL / PER_WORKER)
let connected = 0
let closed = 0
let frames = 0

function startWorker(idx: number, clients: number) {
  const worker = new Worker(
    `
    const { parentPort } = require('worker_threads')
    const WebSocket = require('ws')
    const url = new URL('${WS_URL}')
    if (${BINARY}) url.searchParams.set('binary','1')
    url.searchParams.set('mode','${MODE}')
    if ('${TOKEN}') url.searchParams.set('token','${TOKEN}')
    let connected = 0, closed = 0, frames = 0
    function connectOne() {
      return new Promise((resolve) => {
        const ws = new WebSocket(url.toString())
        ws.on('open', () => { connected++; resolve(null) })
        ws.on('message', () => { frames++ })
        ws.on('close', () => { closed++ })
        ws.on('error', () => resolve(null))
      })
    }
    (async () => {
      for (let i = 0; i < ${clients}; i++) { await connectOne() }
      setInterval(() => {
        parentPort.postMessage({ connected, closed, frames })
      }, 5000)
    })()
  `,
    { eval: true },
  )
  worker.on('message', (m: any) => {
    connected += m.connected
    closed += m.closed
    frames += m.frames
  })
  workers.push(worker)
}

for (let i = 0; i < count; i++) {
  const clients = Math.min(PER_WORKER, TOTAL - i * PER_WORKER)
  startWorker(i, clients)
}

setInterval(() => {
  console.log(
    `workers=${workers.length} connected=${connected} closed=${closed} frames=${frames}`,
  )
}, 5000)
