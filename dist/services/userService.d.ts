import type { BetEligibilityResult, CreateUserInput, UpdateAgeVerificationStatusInput, UpdateUserAccountStatusInput, UserRecord, WalletRecord } from '../user/types.js';
export interface UserService {
    createUser(input: CreateUserInput): Promise<{
        user: UserRecord;
        wallet: WalletRecord;
    }>;
    getUserById(userId: string): Promise<UserRecord>;
    updateAccountStatus(input: UpdateUserAccountStatusInput): Promise<UserRecord>;
    updateAgeVerificationStatus(input: UpdateAgeVerificationStatusInput): Promise<UserRecord>;
    getBetEligibility(userId: string): Promise<BetEligibilityResult>;
}
export declare class DefaultUserService implements UserService {
    private userRepository;
    private walletRepository;
    createUser(input: CreateUserInput): Promise<{
        user: UserRecord;
        wallet: WalletRecord;
    }>;
    getUserById(userId: string): Promise<UserRecord>;
    updateAccountStatus(input: UpdateUserAccountStatusInput): Promise<UserRecord>;
    updateAgeVerificationStatus(input: UpdateAgeVerificationStatusInput): Promise<UserRecord>;
    getBetEligibility(userId: string): Promise<BetEligibilityResult>;
}
export declare function getUserService(): UserService;
