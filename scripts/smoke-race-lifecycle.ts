import { verifyPool, getPool, closePool } from '../src/db/pool.js'
import { RaceState } from '../src/race/raceState.js'
import {
  seedPrecomputedRace,
  startPrecomputedRace,
  streamPrecomputedTickAt,
} from '../src/race/raceEngine.js'

async function waitForPersistence(raceId: string): Promise<{
  lifecycleStatus: string
  persistenceStatus: string
  artifactCount: number
}> {
  const pool = getPool()

  for (let attempt = 0; attempt < 50; attempt++) {
    const raceResult = await pool.query<{
      lifecycle_status: string
      persistence_status: string
    }>(
      `
        select lifecycle_status, persistence_status
        from races
        where race_id = $1
      `,
      [raceId],
    )
    const artifactResult = await pool.query<{ count: number }>(
      `
        select count(*)::int as count
        from race_artifacts
        where race_id = $1
      `,
      [raceId],
    )

    const race = raceResult.rows[0]
    const artifactCount = artifactResult.rows[0]?.count ?? 0
    if (race?.lifecycle_status === 'results_showing' && artifactCount >= 3) {
      return {
        lifecycleStatus: race.lifecycle_status,
        persistenceStatus: race.persistence_status,
        artifactCount,
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  throw new Error(`Timed out waiting for persistence for ${raceId}`)
}

async function waitForLifecycleStatus(
  raceId: string,
  expectedStatus: string,
): Promise<void> {
  const pool = getPool()

  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await pool.query<{ lifecycle_status: string }>(
      `
        select lifecycle_status
        from races
        where race_id = $1
      `,
      [raceId],
    )

    if (result.rows[0]?.lifecycle_status === expectedStatus) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(
    `Timed out waiting for lifecycle_status=${expectedStatus} for ${raceId}`,
  )
}

async function main(): Promise<void> {
  await verifyPool()

  const smokeSeed = process.env.SMOKE_SEED || `smoke-${Date.now()}`
  const startTime = new Date(
    process.env.SMOKE_START_TIME || '2026-03-19T12:00:00.000Z',
  )

  const stateMachine = RaceState.getStateMachine()
  RaceState.setCurrentSeed(smokeSeed)

  const seeded = seedPrecomputedRace()
  RaceState.setPrecomputedRace(seeded)

  stateMachine.transition('countdown')
  stateMachine.transition('race_starting')

  const started = startPrecomputedRace(startTime)
  await waitForLifecycleStatus(started.id, 'running')

  for (let index = 0; index < started.ticks.length; index++) {
    streamPrecomputedTickAt(index)
  }

  const persisted = await waitForPersistence(started.id)
  console.log(`SMOKE_RACE_ID=${started.id}`)
  console.log(
    `SMOKE_RACE_STATUS=${persisted.lifecycleStatus}|${persisted.persistenceStatus}|artifacts=${persisted.artifactCount}`,
  )
}

void main()
  .catch((error) => {
    console.error(String(error))
    process.exitCode = 1
  })
  .finally(async () => {
    await closePool()
  })