export type ClientOptions = {
  url: string
  binary?: boolean
  mode?: 'plain' | 'delta'
  token?: string
}

export type TickFrame = {
  type: 'race:tick' | 'race:keyframe' | 'race:delta'
  seq?: number
  tickTs?: number
  tickIndex?: number
  protoVer?: number
  data?: any
  sig?: string
  keyId?: string
}

export class RaceClient {
  private ws: WebSocket | null = null
  private opts: ClientOptions
  onFrame: ((f: TickFrame) => void) | null = null

  constructor(opts: ClientOptions) {
    this.opts = opts
  }

  connect(): void {
    const u = new URL(this.opts.url)
    if (this.opts.binary) u.searchParams.set('binary', '1')
    if (this.opts.mode) u.searchParams.set('mode', this.opts.mode)
    if (this.opts.token) u.searchParams.set('token', this.opts.token)
    this.ws = new WebSocket(u.toString())
    this.ws.onmessage = (ev) => {
      const data = ev.data
      if (typeof data === 'string') {
        try {
          const obj = JSON.parse(data)
          if (obj.protoVer && obj.protoVer !== 1) {
            // placeholder: handle version negotiation
          }
          this.onFrame && this.onFrame(obj as TickFrame)
        } catch {}
      } else if (data instanceof Blob) {
        // Header + binary body separated by newline
        data.text().then((t) => {
          const idx = t.indexOf('\n')
          if (idx >= 0) {
            try {
              const header = JSON.parse(t.slice(0, idx))
              // version checks
              this.onFrame && this.onFrame(header as TickFrame)
            } catch {}
          }
        })
      }
    }
  }

  requestSync(raceId: string, fromTick?: number): void {
    if (!this.ws) return
    const msg: any = { type: 'sync:request', raceId }
    if (typeof fromTick === 'number') msg.fromTick = fromTick
    this.ws.send(JSON.stringify(msg))
  }
}
