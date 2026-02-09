declare module '../utils/signer.js' {
  export function isSigningEnabled(): boolean
  export function signBytes(data: Buffer): string
  export function getPublicKey(): string
  export function getPublicKeyId(): string
}
