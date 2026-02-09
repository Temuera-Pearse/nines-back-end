import WebSocket from 'ws'

const URL = process.env.WS_URL || 'ws://localhost:3001'
const CLIENTS = Number(process.env.CLIENTS || 500)
const MODE = process.env.MODE === 'delta' ? 'delta' : 'plain'
const BINARY = process.env.BINARY === '1'
const TOKEN = process.env.BROADCAST_TOKEN

function connect(i: number): Promise<WebSocket> {
  return new Promise((resolve) => {
    const u = new URL(URL)
    if (BINARY) u.searchParams.set('binary', '1')
    u.searchParams.set('mode', MODE)
    if (TOKEN) u.searchParams.set('token', TOKEN)
    const ws = new WebSocket(u.toString())
    ws.on('open', () => resolve(ws))
    ws.on('error', () => resolve(ws))
  })
}

async function main() {
  const sockets: WebSocket[] = []
  let frames = 0
  let dropped = 0
  let start = Date.now()
  for (let i = 0; i < CLIENTS; i++) {
    const ws = await connect(i)
    ws.on('message', () => {
      frames++
    })
    ws.on('close', () => {
      dropped++
    })
    sockets.push(ws)
    if (i % 50 === 0) console.log(`connected ${i}`)
  }
  setInterval(() => {
    const elapsed = (Date.now() - start) / 1000
    console.log(
      `clients=${sockets.filter((s) => s.readyState === 1).length} frames=${frames} dropped=${dropped} fps=${(frames / elapsed).toFixed(2)}`,
    )
  }, 5000)
}

main()
