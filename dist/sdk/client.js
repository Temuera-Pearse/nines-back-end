export class RaceClient {
    ws = null;
    opts;
    onFrame = null;
    constructor(opts) {
        this.opts = opts;
    }
    connect() {
        const u = new URL(this.opts.url);
        if (this.opts.binary)
            u.searchParams.set('binary', '1');
        if (this.opts.mode)
            u.searchParams.set('mode', this.opts.mode);
        if (this.opts.token)
            u.searchParams.set('token', this.opts.token);
        this.ws = new WebSocket(u.toString());
        this.ws.onmessage = (ev) => {
            const data = ev.data;
            if (typeof data === 'string') {
                try {
                    const obj = JSON.parse(data);
                    if (obj.protoVer && obj.protoVer !== 1) {
                        // placeholder: handle version negotiation
                    }
                    this.onFrame && this.onFrame(obj);
                }
                catch { }
            }
            else if (data instanceof Blob) {
                // Header + binary body separated by newline
                data.text().then((t) => {
                    const idx = t.indexOf('\n');
                    if (idx >= 0) {
                        try {
                            const header = JSON.parse(t.slice(0, idx));
                            // version checks
                            this.onFrame && this.onFrame(header);
                        }
                        catch { }
                    }
                });
            }
        };
    }
    requestSync(raceId, fromTick) {
        if (!this.ws)
            return;
        const msg = { type: 'sync:request', raceId };
        if (typeof fromTick === 'number')
            msg.fromTick = fromTick;
        this.ws.send(JSON.stringify(msg));
    }
}
