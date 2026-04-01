export const DEFAULT_MINIMUM_BETTING_AGE = 18;
export function getMinimumBettingAge() {
    const value = Number(process.env.MINIMUM_BETTING_AGE || DEFAULT_MINIMUM_BETTING_AGE);
    return Number.isInteger(value) && value > 0
        ? value
        : DEFAULT_MINIMUM_BETTING_AGE;
}
export function calculateAge(dateOfBirth, now = new Date()) {
    const birthDate = new Date(`${dateOfBirth}T00:00:00.000Z`);
    let age = now.getUTCFullYear() - birthDate.getUTCFullYear();
    const monthDelta = now.getUTCMonth() - birthDate.getUTCMonth();
    const dayDelta = now.getUTCDate() - birthDate.getUTCDate();
    if (monthDelta < 0 || (monthDelta === 0 && dayDelta < 0)) {
        age -= 1;
    }
    return age;
}
export function isOfBettingAge(dateOfBirth, now = new Date()) {
    return calculateAge(dateOfBirth, now) >= getMinimumBettingAge();
}
export function deriveInitialAgeVerificationStatus(dateOfBirth, now = new Date()) {
    return isOfBettingAge(dateOfBirth, now) ? 'self_attested' : 'underage';
}
