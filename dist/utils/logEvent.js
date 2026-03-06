const ts = () => new Date().toISOString();
export function logEvent(eventType, payload) {
    const raceId = payload.raceId;
    const base = { ts: ts(), eventType, ...(raceId ? { raceId } : {}) };
    console.log(JSON.stringify({ ...base, detail: payload }));
}
