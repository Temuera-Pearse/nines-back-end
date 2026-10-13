export function getDisposablePostgresTestUrl(
  source: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = source.NINES_BACKEND_DISPOSABLE_PG_URL?.trim()
  if (!value) return null
  if (source.NINES_BACKEND_DISPOSABLE_PG_ALLOW_RESET !== '1') {
    throw new Error('NINES_BACKEND_DISPOSABLE_PG_ALLOW_RESET=1 is required')
  }
  if (source.DATABASE_URL?.trim() === value) {
    throw new Error('Disposable PostgreSQL tests must not use DATABASE_URL')
  }
  const databaseName = new URL(value).pathname.replace(/^\//, '')
  if (!/(?:test|disposable)/i.test(databaseName) ||
      /(?:^|[_-])(?:dev|development|prod|production)(?:[_-]|$)/i.test(databaseName)) {
    throw new Error('Disposable PostgreSQL database name must be test-only, never development or production')
  }
  return value
}
