import { promises as fs } from 'fs'
import { join, resolve } from 'path'
import { initPool, getPool, closePool } from '../src/db/pool.js'

async function ensureMigrationsTable(): Promise<void> {
  const pool = getPool()
  await pool.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `)
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const pool = getPool()
  const result = await pool.query<{ name: string }>(
    'select name from schema_migrations order by name asc',
  )
  return new Set(result.rows.map((row) => row.name))
}

async function applyMigration(name: string, sql: string): Promise<void> {
  const pool = getPool()
  const client = await pool.connect()

  try {
    await client.query('begin')
    await client.query(sql)
    await client.query(
      'insert into schema_migrations (name) values ($1) on conflict (name) do nothing',
      [name],
    )
    await client.query('commit')
    console.log(`Applied migration ${name}`)
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required')
  }

  initPool()
  await ensureMigrationsTable()

  const migrationsDir = resolve('db/migrations')
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))

  const applied = await getAppliedMigrations()
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`Skipping migration ${file}`)
      continue
    }

    const sql = await fs.readFile(join(migrationsDir, file), 'utf8')
    await applyMigration(file, sql)
  }

  console.log('Migration run complete')
}

void main()
  .catch((error) => {
    console.error(String(error))
    process.exitCode = 1
  })
  .finally(async () => {
    await closePool()
  })