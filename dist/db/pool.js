import { Pool } from 'pg';
let pool = null;
export function isDatabaseConfigured() {
    return Boolean(process.env.DATABASE_URL);
}
export function initPool() {
    if (pool)
        return pool;
    if (!isDatabaseConfigured())
        return null;
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
    });
    return pool;
}
export function getPool() {
    const next = initPool();
    if (!next) {
        throw new Error('DATABASE_URL is not configured');
    }
    return next;
}
export function getOptionalPool() {
    return initPool();
}
export async function verifyPool() {
    const next = initPool();
    if (!next)
        return;
    await next.query('select 1');
}
export async function closePool() {
    if (!pool)
        return;
    await pool.end();
    pool = null;
}
