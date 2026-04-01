import { getOptionalPool } from './pool.js';
function normalizeDateOfBirth(value) {
    if (typeof value === 'string') {
        return value.slice(0, 10);
    }
    return value.toISOString().slice(0, 10);
}
function mapUserRow(row) {
    return {
        id: row.id,
        username: row.username,
        email: row.email,
        accountStatus: row.account_status,
        dateOfBirth: normalizeDateOfBirth(row.date_of_birth),
        ageVerificationStatus: row.age_verification_status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
export class PgUserRepository {
    async createUser(input, queryable) {
        const db = queryable ?? getOptionalPool();
        if (!db) {
            throw new Error('DATABASE_URL is not configured');
        }
        const result = await db.query(`
        insert into users (
          id,
          username,
          email,
          account_status,
          date_of_birth,
          age_verification_status,
          created_at,
          updated_at
        ) values ($1, $2, $3, $4, $5, $6, now(), now())
        returning *
      `, [
            input.id,
            input.username,
            input.email ?? null,
            input.accountStatus,
            input.dateOfBirth,
            input.ageVerificationStatus,
        ]);
        return mapUserRow(result.rows[0]);
    }
    async findUserById(userId) {
        const pool = getOptionalPool();
        if (!pool)
            return null;
        const result = await pool.query(`
        select *
        from users
        where id = $1
        limit 1
      `, [userId]);
        return result.rows[0] ? mapUserRow(result.rows[0]) : null;
    }
    async findUserByUsername(username) {
        const pool = getOptionalPool();
        if (!pool)
            return null;
        const result = await pool.query(`
        select *
        from users
        where lower(username) = lower($1)
        limit 1
      `, [username]);
        return result.rows[0] ? mapUserRow(result.rows[0]) : null;
    }
    async findUserByEmail(email) {
        const pool = getOptionalPool();
        if (!pool)
            return null;
        const result = await pool.query(`
        select *
        from users
        where lower(email) = lower($1)
        limit 1
      `, [email]);
        return result.rows[0] ? mapUserRow(result.rows[0]) : null;
    }
    async updateAccountStatus(input) {
        const pool = getOptionalPool();
        if (!pool)
            return null;
        const result = await pool.query(`
        update users
        set account_status = $2,
            updated_at = now()
        where id = $1
        returning *
      `, [input.userId, input.accountStatus]);
        return result.rows[0] ? mapUserRow(result.rows[0]) : null;
    }
    async updateAgeVerificationStatus(input) {
        const pool = getOptionalPool();
        if (!pool)
            return null;
        const result = await pool.query(`
        update users
        set age_verification_status = $2,
            updated_at = now()
        where id = $1
        returning *
      `, [input.userId, input.ageVerificationStatus]);
        return result.rows[0] ? mapUserRow(result.rows[0]) : null;
    }
}
let sharedUserRepository = null;
export function getUserRepository() {
    if (!sharedUserRepository) {
        sharedUserRepository = new PgUserRepository();
    }
    return sharedUserRepository;
}
