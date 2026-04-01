import { Pool } from 'pg';
export declare function isDatabaseConfigured(): boolean;
export declare function initPool(): Pool | null;
export declare function getPool(): Pool;
export declare function getOptionalPool(): Pool | null;
export declare function verifyPool(): Promise<void>;
export declare function closePool(): Promise<void>;
