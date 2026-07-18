const ts = () => new Date().toISOString()

export function logEvent(eventType: string, payload: Record<string, any>) {
  const {
    raceId: _raceId,
    seed: _seed,
    privateSeed: _privateSeed,
    seedInt: _seedInt,
    ...safeDetail
  } = payload
  const raceRef =
    typeof safeDetail.raceRef === 'string' ? safeDetail.raceRef : undefined
  const base = { ts: ts(), eventType, ...(raceRef ? { raceRef } : {}) }
  console.log(JSON.stringify({ ...base, detail: safeDetail }))
}
