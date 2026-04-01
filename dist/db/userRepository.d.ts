import type { Pool, PoolClient } from 'pg';
import type { AgeVerificationStatus, CreateUserInput, UpdateAgeVerificationStatusInput, UpdateUserAccountStatusInput, UserAccountStatus, UserRecord } from '../user/types.js';
type Queryable = Pool | PoolClient;
export interface CreateUserRecordInput extends CreateUserInput {
    id: string;
    accountStatus: UserAccountStatus;
    ageVerificationStatus: AgeVerificationStatus;
}
export interface UserRepository {
    createUser(input: CreateUserRecordInput, queryable?: Queryable): Promise<UserRecord>;
    findUserById(userId: string): Promise<UserRecord | null>;
    findUserByUsername(username: string): Promise<UserRecord | null>;
    findUserByEmail(email: string): Promise<UserRecord | null>;
    updateAccountStatus(input: UpdateUserAccountStatusInput): Promise<UserRecord | null>;
    updateAgeVerificationStatus(input: UpdateAgeVerificationStatusInput): Promise<UserRecord | null>;
}
export declare class PgUserRepository implements UserRepository {
    createUser(input: CreateUserRecordInput, queryable?: Queryable): Promise<UserRecord>;
    findUserById(userId: string): Promise<UserRecord | null>;
    findUserByUsername(username: string): Promise<UserRecord | null>;
    findUserByEmail(email: string): Promise<UserRecord | null>;
    updateAccountStatus(input: UpdateUserAccountStatusInput): Promise<UserRecord | null>;
    updateAgeVerificationStatus(input: UpdateAgeVerificationStatusInput): Promise<UserRecord | null>;
}
export declare function getUserRepository(): UserRepository;
export {};
