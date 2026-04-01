import { WebSocketServer } from 'ws';
import { RaceState } from '../race/raceState.js';
import { activeRaces } from '../race/activeRaceMemory.js';
import { engineMetrics } from '../metrics/engineMetrics.js';
import { getPublicKeyId, isSigningEnabled, signBytes } from '../utils/signer';
import { URL } from 'url';
import { getBus } from '../broadcast/bus.js';
import { getLeaderRole } from '../leader/elector.js';
import { performance } from 'perf_hooks';
const ts = () => new Date().toISOString();
const PROTO_VER = Number(process.env.PROTO_VER || 1);
// Catch-up window/rate limit constants
const MAX_CATCHUP_TICKS = 50;
const DEFAULT_CATCHUP_TICKS = 10;
const SYNC_COOLDOWN_MS = 2000;
// Backpressure + keepalive config
const WS_BACKPRESSURE_THRESHOLD = Number(process.env.WS_BACKPRESSURE_THRESHOLD || 1_000_000); // bytes
const WS_PING_INTERVAL_MS = Number(process.env.WS_PING_INTERVAL_MS || 30_000);
const LOG_VERBOSE = process.env.LOG_VERBOSE === '1';
// Keyframe cadence (ticks)
const KEYFRAME_INTERVAL_TICKS = Number(process.env.KEYFRAME_INTERVAL_TICKS || 20);
// Per-client last sync timestamp
const lastSyncByClient = new WeakMap();
const clientPrefs = new WeakMap();
const clientAlive = new WeakMap();
// Per-race sequencing
const seqByRace = new Map();
const lastKeyframeTickByRace = new Map();
const lastPositionsByRace = new Map();
// Utility: compute currentTickIndex for a race based on startTime and snapshot length
function getCurrentTickIndex(raceId) {
    const rec = activeRaces.get(raceId);
    if (!rec)
        return -1;
    return typeof rec.currentTickIndex === 'number' ? rec.currentTickIndex : -1;
}
function buildWinnerDeclaredPayload(pre) {
    if (!pre.startTime || !pre.winnerId)
        return null;
    const winnerCrossMs = pre.finishTimesMs[pre.winnerId];
    if (!Number.isFinite(winnerCrossMs))
        return null;
    const timestampMs = pre.startTime.getTime() + winnerCrossMs;
    return {
        raceId: pre.id,
        timestampUtc: new Date(timestampMs).toISOString(),
        winnerId: pre.winnerId,
        finishOrder: [...pre.finishOrder],
        finishTimesMs: { ...pre.finishTimesMs },
        finishTickIndex: { ...pre.finishTickIndex },
        presentation: {
            bannerVisibleUntilUtc: new Date(timestampMs + 3400).toISOString(),
            resultsVisibleUntilUtc: pre.authoritativeFinish?.presentation
                .resultsVisibleUntilUtc
                ? pre.authoritativeFinish.presentation.resultsVisibleUntilUtc
                : new Date(Math.ceil(timestampMs / 60_000) * 60_000).toISOString(),
        },
    };
}
function maybeReplayWinnerDeclared(ws, pre, currentTickIndex) {
    const winnerTickIndex = pre.finishTickIndex[pre.winnerId] ?? Number.POSITIVE_INFINITY;
    if (currentTickIndex < winnerTickIndex)
        return;
    const payload = buildWinnerDeclaredPayload(pre);
    if (!payload)
        return;
    ws.send(JSON.stringify({
        type: 'race:winner-declared',
        protoVer: PROTO_VER,
        ...payload,
    }));
}
// Handle sync requests from clients
function handleSyncRequest(ws, msg) {
    const startedAt = performance.now();
    engineMetrics.recordSyncRequest();
    const now = Date.now();
    const last = lastSyncByClient.get(ws) ?? 0;
    if (now - last < SYNC_COOLDOWN_MS) {
        // rate-limited
        engineMetrics.recordSyncRateLimited();
        return;
    }
    lastSyncByClient.set(ws, now);
    const raceId = msg?.raceId;
    if (!raceId || !activeRaces.has(raceId)) {
        engineMetrics.recordSyncError();
        ws.send(JSON.stringify({ type: 'error', message: 'invalid raceId' }));
        return;
    }
    const currentTickIndex = getCurrentTickIndex(raceId);
    const rec = activeRaces.get(raceId);
    const fromTick = typeof msg?.fromTick === 'number' ? msg.fromTick : undefined;
    let startIndex;
    if (typeof fromTick === 'number') {
        const minAllowed = Math.max(0, currentTickIndex - MAX_CATCHUP_TICKS);
        startIndex = Math.max(minAllowed, Math.min(fromTick, currentTickIndex));
    }
    else {
        startIndex = Math.max(0, currentTickIndex - DEFAULT_CATCHUP_TICKS);
    }
    const ticksWindow = rec.ticks.slice(startIndex, currentTickIndex + 1);
    const nowMs = Date.now();
    const tickFrames = ticksWindow.map((t) => ({
        type: 'race:tick',
        protoVer: PROTO_VER,
        raceId,
        // If seq was captured at broadcast time, use it; otherwise fall back to tickIndex.
        seq: typeof t.seq === 'number' ? t.seq : t.tickIndex,
        tickIndex: t.tickIndex,
        tickTs: typeof t.tickTs === 'number' ? t.tickTs : nowMs,
        data: {
            positions: t.positions,
            events: t.events,
            effects: t.effects,
        },
    }));
    ws.send(JSON.stringify({
        type: 'race:catchup',
        protoVer: PROTO_VER,
        raceId,
        startIndex,
        ticks: tickFrames,
        currentTickIndex,
    }));
    ws.send(JSON.stringify({
        type: 'race:sync-complete',
        protoVer: PROTO_VER,
        raceId,
        currentTickIndex,
    }));
    const pre = RaceState.findPrecomputedById(raceId);
    if (pre && !pre.endTime) {
        maybeReplayWinnerDeclared(ws, pre, currentTickIndex);
    }
    engineMetrics.recordCatchupWindow(tickFrames.length, performance.now() - startedAt);
}
/**
 * WebSocket server for real-time race updates
 */
export class RaceWebSocketServer {
    static wss;
    static clients = new Set();
    static droppedTickFrames = 0;
    static bufferedAmountRing = [];
    static bufferedAmountRingCap = 200;
    static role = 'edge';
    static init(server) {
        this.wss = new WebSocketServer({ server });
        this.wss.on('connection', (ws, req) => {
            this.clients.add(ws);
            engineMetrics.setClientCount(this.clients.size);
            if (LOG_VERBOSE) {
                console.log(`[${ts()}][WS] Client connected. Total clients=${this.clients.size}`);
            }
            // Parse client preferences from query string
            try {
                const url = new URL(req?.url || '/', 'http://localhost');
                if (process.env.REQUIRE_TOKEN === '1') {
                    const tok = url.searchParams.get('token');
                    const expected = process.env.BROADCAST_TOKEN || '';
                    if (!tok || tok !== expected) {
                        try {
                            ws.close(1008, 'unauthorized');
                        }
                        catch { }
                        this.clients.delete(ws);
                        engineMetrics.setClientCount(this.clients.size);
                        return;
                    }
                }
                const binary = url.searchParams.get('binary') === '1';
                const modeParam = url.searchParams.get('mode');
                const mode = modeParam === 'delta' ? 'delta' : 'plain';
                clientPrefs.set(ws, { binary, mode });
            }
            catch {
                clientPrefs.set(ws, { binary: false, mode: 'plain' });
            }
            // keepalive
            clientAlive.set(ws, true);
            ws.on('pong', () => clientAlive.set(ws, true));
            // On connect: only provide basic race info; client requests catch-up
            const pre = RaceState.getPrecomputedRace();
            if (pre?.id) {
                const currentTickIndex = activeRaces.has(pre.id)
                    ? getCurrentTickIndex(pre.id)
                    : -1;
                ws.send(JSON.stringify({
                    type: 'race:info',
                    protoVer: PROTO_VER,
                    raceId: pre.id,
                    horseOrder: pre.horses.map((h) => h.id),
                    config: pre.config,
                    currentTickIndex,
                }));
                if (!pre.endTime) {
                    maybeReplayWinnerDeclared(ws, pre, currentTickIndex);
                }
                // If the race has already finished (client joined during results window),
                // replay race:finish so they can show the podium without waiting.
                if (pre.endTime) {
                    const finish = pre.authoritativeFinish;
                    if (finish) {
                        ws.send(JSON.stringify({
                            type: 'race:finish',
                            protoVer: PROTO_VER,
                            ...finish,
                        }));
                    }
                }
            }
            ws.on('message', (data) => {
                let msg;
                try {
                    msg = JSON.parse(String(data));
                }
                catch {
                    return;
                }
                if (msg?.type === 'sync:request') {
                    handleSyncRequest(ws, msg);
                }
            });
            ws.on('close', () => {
                this.clients.delete(ws);
                engineMetrics.setClientCount(this.clients.size);
                if (LOG_VERBOSE) {
                    console.log(`[${ts()}][WS] Client disconnected. Total clients=${this.clients.size}`);
                }
            });
            ws.on('error', (err) => {
                this.clients.delete(ws);
                engineMetrics.setClientCount(this.clients.size);
                console.warn(`[${ts()}][WS] Client error: ${String(err)}`);
            });
        });
        console.log(`[${ts()}][WS] WebSocket server initialized`);
        // Ping/pong keepalive
        setInterval(() => {
            for (const ws of this.clients) {
                const alive = clientAlive.get(ws);
                if (alive === false) {
                    try {
                        ws.terminate();
                    }
                    catch { }
                    this.clients.delete(ws);
                    engineMetrics.setClientCount(this.clients.size);
                    continue;
                }
                clientAlive.set(ws, false);
                try {
                    ws.ping();
                }
                catch { }
            }
        }, WS_PING_INTERVAL_MS);
    }
    static setRole(role) {
        this.role = role;
    }
    static broadcast(message) {
        const broadcastStartedAt = performance.now();
        const type = message?.type ?? 'unknown';
        const raceId = message?.raceId ??
            message?.data?.raceId ??
            (Array.isArray(message?.data) ? undefined : message?.data?.id);
        if (LOG_VERBOSE) {
            console.log(`[${ts()}][WS] Broadcast ${type}${raceId ? ` [${raceId}]` : ''} to ${this.clients.size} clients`);
        }
        // Attach sequencing + timestamp for tick frames (leader only)
        let payloadObj = message;
        let tickIndex = undefined;
        const nowMs = Date.now();
        const role = this.role || getLeaderRole();
        const isLeader = role === 'leader';
        if (isLeader && type === 'race:tick' && raceId) {
            const currentSeq = (seqByRace.get(raceId) || 0) + 1;
            seqByRace.set(raceId, currentSeq);
            if (typeof message?.data?.tickIndex === 'number') {
                tickIndex = message.data.tickIndex;
            }
            payloadObj = {
                ...message,
                seq: currentSeq,
                tickTs: nowMs,
                protoVer: PROTO_VER,
            };
            engineMetrics.setLatestSeq(raceId, currentSeq);
            // Capture sequencing for catch-up consumers (best-effort)
            try {
                const positions = payloadObj?.data?.positions;
                if (typeof tickIndex === 'number' && Array.isArray(positions)) {
                    const rec = activeRaces.get(raceId);
                    if (rec && Array.isArray(rec.ticks) && rec.ticks[tickIndex]) {
                        rec.ticks[tickIndex].seq = currentSeq;
                        rec.ticks[tickIndex].tickTs = nowMs;
                        rec.currentTickIndex = Math.max(rec.currentTickIndex ?? -1, tickIndex);
                        activeRaces.set(raceId, rec);
                    }
                }
            }
            catch {
                // non-fatal
            }
        }
        // Ensure protoVer exists on all outgoing JSON frames
        if (payloadObj &&
            typeof payloadObj === 'object' &&
            payloadObj.protoVer === undefined) {
            payloadObj = { ...payloadObj, protoVer: PROTO_VER };
        }
        // Serialize (without signature) for signing + size
        let payloadJson = '';
        try {
            payloadJson = JSON.stringify(payloadObj);
        }
        catch {
            payloadJson = JSON.stringify({ type });
        }
        // Optional signing (leader only)
        if (isLeader && type === 'race:tick' && isSigningEnabled()) {
            try {
                const sig = signBytes(Buffer.from(payloadJson));
                payloadObj = { ...payloadObj, sig, keyId: getPublicKeyId() };
                payloadJson = JSON.stringify(payloadObj);
            }
            catch { }
        }
        // Broadcast with backpressure skip for ticks
        for (const client of this.clients) {
            if (client.readyState !== 1)
                continue;
            const prefs = clientPrefs.get(client) || { binary: false, mode: 'plain' };
            const bufAmt = client.bufferedAmount || 0;
            this.bufferedAmountRing.push(bufAmt);
            if (this.bufferedAmountRing.length > this.bufferedAmountRingCap) {
                this.bufferedAmountRing.shift();
            }
            engineMetrics.recordBufferedAmount(bufAmt);
            if (type === 'race:tick' && bufAmt > WS_BACKPRESSURE_THRESHOLD) {
                // Protect loop: skip tick frame for this client
                this.droppedTickFrames++;
                engineMetrics.incDroppedTickFrames();
                continue;
            }
            if (prefs.binary && type === 'race:tick') {
                // Experimental binary: send positions as Float32Array if present
                const positions = payloadObj?.data?.positions;
                if (Array.isArray(positions)) {
                    const header = Buffer.from(JSON.stringify({
                        type,
                        seq: payloadObj.seq,
                        tickTs: payloadObj.tickTs,
                        tickIndex,
                        protoVer: PROTO_VER,
                        data: {
                            events: payloadObj?.data?.events,
                            effects: payloadObj?.data?.effects,
                        },
                    }));
                    const arr = new Float32Array(positions);
                    const body = Buffer.from(arr.buffer);
                    const out = Buffer.concat([header, Buffer.from('\n'), body]);
                    try {
                        client.send(out, { binary: true });
                    }
                    catch { }
                    continue;
                }
            }
            // Optional delta mode for JSON clients
            if (!prefs.binary && prefs.mode === 'delta' && type === 'race:tick') {
                const positions = payloadObj?.data?.positions;
                if (Array.isArray(positions) &&
                    typeof tickIndex === 'number' &&
                    raceId) {
                    const lastKeyTick = lastKeyframeTickByRace.get(raceId) || -Infinity;
                    const needKeyframe = !Number.isFinite(lastKeyTick) ||
                        tickIndex - lastKeyTick >= KEYFRAME_INTERVAL_TICKS;
                    if (needKeyframe) {
                        lastKeyframeTickByRace.set(raceId, tickIndex);
                        lastPositionsByRace.set(raceId, positions.slice());
                        const keyframeMsg = { ...payloadObj, type: 'race:keyframe' };
                        try {
                            client.send(JSON.stringify(keyframeMsg));
                        }
                        catch { }
                        continue;
                    }
                    else {
                        const lastPos = lastPositionsByRace.get(raceId);
                        if (Array.isArray(lastPos) && lastPos.length === positions.length) {
                            const deltas = positions.map((p, i) => p - lastPos[i]);
                            // update last positions
                            lastPositionsByRace.set(raceId, positions.slice());
                            const deltaMsg = {
                                ...payloadObj,
                                type: 'race:delta',
                                data: { ...payloadObj.data, deltas },
                            };
                            try {
                                client.send(JSON.stringify(deltaMsg));
                            }
                            catch { }
                            continue;
                        }
                    }
                }
            }
            try {
                client.send(payloadJson);
            }
            catch { }
        }
        if (type === 'race:tick' ||
            type === 'race:keyframe' ||
            type === 'race:delta') {
            engineMetrics.recordFanout(performance.now() - broadcastStartedAt);
        }
        // Optional bus publish (SOT fan-out) leader only
        try {
            if (isLeader &&
                raceId &&
                (type === 'race:tick' ||
                    type === 'race:keyframe' ||
                    type === 'race:delta')) {
                const topic = `race.${raceId}`;
                const publishStartedAt = performance.now();
                getBus()
                    .publish(topic, Buffer.from(payloadJson))
                    .then(() => {
                    engineMetrics.recordBusPublish(performance.now() - publishStartedAt);
                })
                    .catch(() => {
                    engineMetrics.recordBusPublishError(performance.now() - publishStartedAt);
                });
            }
        }
        catch { }
    }
}
