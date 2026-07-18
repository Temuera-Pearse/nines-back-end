import { randomUUID } from 'node:crypto'

export type RaceIdFactory = () => string

/**
 * Allocate a public race identifier independently from all deterministic race
 * generation state. Race IDs are opaque protocol identifiers; callers must not
 * encode or recover private seed material from them.
 */
export const createOpaqueRaceId: RaceIdFactory = () => `race-${randomUUID()}`
