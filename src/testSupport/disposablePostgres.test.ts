import { describe, expect, it } from 'vitest'

import { getDisposablePostgresTestUrl } from './disposablePostgres.js'

const base = {
  NINES_BACKEND_DISPOSABLE_PG_ALLOW_RESET: '1',
}

describe('disposable PostgreSQL test configuration', () => {
  it('accepts only an explicitly resettable test database separate from DATABASE_URL', () => {
    const disposable = 'postgres://localhost/nines_backend_disposable_test'
    expect(getDisposablePostgresTestUrl({ ...base,
      NINES_BACKEND_DISPOSABLE_PG_URL: disposable })).toBe(disposable)
    expect(() => getDisposablePostgresTestUrl({ ...base,
      DATABASE_URL: disposable,
      NINES_BACKEND_DISPOSABLE_PG_URL: disposable })).toThrow('must not use DATABASE_URL')
  })

  it.each(['nines_backend_dev_test', 'nines_backend_production_test', 'nines_backend'])
  ('rejects an unsafe database name: %s', (databaseName) => {
    expect(() => getDisposablePostgresTestUrl({ ...base,
      NINES_BACKEND_DISPOSABLE_PG_URL: `postgres://localhost/${databaseName}` }))
      .toThrow('test-only')
  })
})
