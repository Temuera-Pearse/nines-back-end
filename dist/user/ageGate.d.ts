import type { AgeVerificationStatus } from './types.js';
export declare const DEFAULT_MINIMUM_BETTING_AGE = 18;
export declare function getMinimumBettingAge(): number;
export declare function calculateAge(dateOfBirth: string, now?: Date): number;
export declare function isOfBettingAge(dateOfBirth: string, now?: Date): boolean;
export declare function deriveInitialAgeVerificationStatus(dateOfBirth: string, now?: Date): AgeVerificationStatus;
