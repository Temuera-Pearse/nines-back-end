import { randomBytes, randomUUID } from 'node:crypto'

declare const raceIdBrand: unique symbol
declare const raceRefBrand: unique symbol

export type RaceId = string & { readonly [raceIdBrand]: true }
export type RaceRef = string & { readonly [raceRefBrand]: true }
export type RaceIdFactory = () => RaceId
export type RaceRefFactory = () => RaceRef

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const allocatedRaceRefs = new Set<string>()

/**
 * Allocate the private database/coordination identity independently from all
 * deterministic race generation state. This value must never cross a public
 * REST or WebSocket boundary.
 */
export const createOpaqueRaceId: RaceIdFactory = () =>
  `race-${randomUUID()}` as RaceId

/** Generate the canonical public N9 reference from independent CSPRNG bytes. */
export const createRaceRef: RaceRefFactory = () => {
  const bytes = randomBytes(10)
  let value = ''
  for (const byte of bytes) value += CROCKFORD_ALPHABET[byte & 31]
  return `N9-${value.slice(0, 5)}-${value.slice(5)}` as RaceRef
}

/** Reserve a process-unique public reference, regenerating ordinary collisions. */
export function allocateUniqueRaceRef(
  factory: RaceRefFactory = createRaceRef,
): RaceRef {
  for (let attempt = 0; attempt < 128; attempt++) {
    const raceRef = factory().toUpperCase() as RaceRef
    if (!/^N9-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/.test(raceRef)) {
      throw new Error('Race reference generator returned an invalid value')
    }
    if (allocatedRaceRefs.has(raceRef)) continue
    allocatedRaceRefs.add(raceRef)
    return raceRef
  }
  throw new Error('Unable to allocate a unique race reference')
}

export function resetAllocatedRaceRefsForTests(): void {
  allocatedRaceRefs.clear()
}
