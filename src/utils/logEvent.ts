const ts = () => new Date().toISOString()

export function logEvent(eventType: string, payload: Record<string, any>) {
  const raceId = payload.raceId
  const base = { ts: ts(), eventType, ...(raceId ? { raceId } : {}) }
  console.log(JSON.stringify({ ...base, detail: payload }))
}
