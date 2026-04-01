import { getOptionalPool } from './pool.js';
function mapWalletRow(row) {
    return {
        id: row.id,
        userId: row.user_id,
        currency: row.currency,
        balanceMinor: BigInt(String(row.balance_minor)),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
export class PgWalletRepository {
    async createWallet(input, queryable) {
        const db = queryable ?? getOptionalPool();
        if (!db) {
            throw new Error('DATABASE_URL is not configured');
        }
        const result = await db.query(`
        insert into wallets (
          id,
          user_id,
          currency,
          balance_minor,
          created_at,
          updated_at
        ) values ($1, $2, $3, $4, now(), now())
        returning *
      `, [
            input.id,
            input.userId,
            input.currency,
            String(input.balanceMinor ?? 0n),
        ]);
        return mapWalletRow(result.rows[0]);
    }
    async findWalletByUserId(userId, currency = 'USD') {
        const pool = getOptionalPool();
        if (!pool)
            return null;
        const result = await pool.query(`
        select *
        from wallets
        where user_id = $1 and currency = $2
        limit 1
      `, [userId, currency]);
        return result.rows[0] ? mapWalletRow(result.rows[0]) : null;
    }
    async findWalletById(walletId) {
        const pool = getOptionalPool();
        if (!pool)
            return null;
        const result = await pool.query(`
        select *
        from wallets
        where id = $1
        limit 1
      `, [walletId]);
        return result.rows[0] ? mapWalletRow(result.rows[0]) : null;
    }
    async findWalletByUserIdForUpdate(userId, currency, queryable) {
        const result = await queryable.query(`
        select *
        from wallets
        where user_id = $1 and currency = $2
        limit 1
        for update
      `, [userId, currency]);
        return result.rows[0] ? mapWalletRow(result.rows[0]) : null;
    }
    async updateBalanceMinor(walletId, balanceMinor, queryable) {
        const result = await queryable.query(`
        update wallets
        set balance_minor = $2,
            updated_at = now()
        where id = $1
        returning *
      `, [walletId, String(balanceMinor)]);
        return mapWalletRow(result.rows[0]);
    }
}
let sharedWalletRepository = null;
export function getWalletRepository() {
    if (!sharedWalletRepository) {
        sharedWalletRepository = new PgWalletRepository();
    }
    return sharedWalletRepository;
}
