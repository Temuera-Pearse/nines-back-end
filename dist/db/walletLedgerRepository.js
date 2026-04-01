import { getOptionalPool } from './pool.js';
function mapWalletLedgerRow(row) {
    return {
        id: Number(row.id),
        walletId: row.wallet_id,
        entryType: row.entry_type,
        deltaMinor: BigInt(String(row.delta_minor)),
        balanceAfterMinor: BigInt(String(row.balance_after_minor)),
        referenceType: row.reference_type,
        referenceId: row.reference_id,
        metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
        createdAt: row.created_at,
    };
}
export class PgWalletLedgerRepository {
    async createEntry(input, queryable) {
        const result = await queryable.query(`
        insert into wallet_ledger_entries (
          wallet_id,
          entry_type,
          delta_minor,
          balance_after_minor,
          reference_type,
          reference_id,
          metadata,
          created_at
        ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
        returning *
      `, [
            input.walletId,
            input.entryType,
            String(input.deltaMinor),
            String(input.balanceAfterMinor),
            input.referenceType ?? null,
            input.referenceId ?? null,
            JSON.stringify(input.metadata ?? {}),
        ]);
        return mapWalletLedgerRow(result.rows[0]);
    }
    async listEntriesByWalletId(walletId) {
        const pool = getOptionalPool();
        if (!pool)
            return [];
        const result = await pool.query(`
        select *
        from wallet_ledger_entries
        where wallet_id = $1
        order by created_at asc, id asc
      `, [walletId]);
        return result.rows.map(mapWalletLedgerRow);
    }
}
let sharedWalletLedgerRepository = null;
export function getWalletLedgerRepository() {
    if (!sharedWalletLedgerRepository) {
        sharedWalletLedgerRepository = new PgWalletLedgerRepository();
    }
    return sharedWalletLedgerRepository;
}
