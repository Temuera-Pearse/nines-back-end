import crypto from 'crypto'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager'

let privateKeyPem: string | null = process.env.TICK_SIGNING_PRIVATE_KEY || null
let publicKeyPem: string | null = process.env.TICK_SIGNING_PUBLIC_KEY || null
let keyId: string | null = null

const ssm = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' })
const secrets = new SecretsManagerClient({
  region: process.env.AWS_REGION || 'us-east-1',
})

async function loadKeysFromAws(): Promise<void> {
  try {
    const ssmParam = process.env.TICK_SIGNING_PRIVATE_KEY_SSM
    const secId = process.env.TICK_SIGNING_SECRET_ID
    if (ssmParam) {
      const out = await ssm.send(
        new GetParameterCommand({ Name: ssmParam, WithDecryption: true }),
      )
      privateKeyPem = out.Parameter?.Value || privateKeyPem
    }
    if (secId) {
      const out = await secrets.send(
        new GetSecretValueCommand({ SecretId: secId }),
      )
      const val =
        out.SecretString ||
        (out.SecretBinary
          ? Buffer.from(out.SecretBinary as any).toString('utf8')
          : null)
      if (val) privateKeyPem = val
    }
  } catch {
    // ignore
  }
}

function genKeyPair(): void {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()
}

async function ensureKeysAsync(): Promise<void> {
  if (!privateKeyPem || !publicKeyPem) {
    await loadKeysFromAws()
  }
  if (!privateKeyPem || !publicKeyPem) {
    genKeyPair()
  }
  const der = crypto
    .createPublicKey(publicKeyPem!)
    .export({ format: 'der', type: 'spki' }) as Buffer
  const fp = crypto.createHash('sha256').update(der).digest('hex')
  keyId = fp.slice(0, 16)
}

export function isSigningEnabled(): boolean {
  return true
}

export async function signBytesAsync(data: Buffer): Promise<string> {
  await ensureKeysAsync()
  const priv = crypto.createPrivateKey(privateKeyPem!)
  const sig = crypto.sign(null, data, priv)
  return sig.toString('base64')
}

export function signBytes(data: Buffer): string {
  if (!privateKeyPem || !publicKeyPem) {
    genKeyPair()
    const der = crypto
      .createPublicKey(publicKeyPem!)
      .export({ format: 'der', type: 'spki' }) as Buffer
    const fp = crypto.createHash('sha256').update(der).digest('hex')
    keyId = fp.slice(0, 16)
  }
  const priv = crypto.createPrivateKey(privateKeyPem!)
  const sig = crypto.sign(null, data, priv)
  return sig.toString('base64')
}

export async function getPublicKeyAsync(): Promise<string> {
  await ensureKeysAsync()
  return publicKeyPem!
}

export function getPublicKey(): string {
  if (!publicKeyPem) genKeyPair()
  return publicKeyPem!
}

export async function getPublicKeyIdAsync(): Promise<string> {
  await ensureKeysAsync()
  return keyId!
}

export function getPublicKeyId(): string {
  if (!keyId) {
    if (!publicKeyPem) genKeyPair()
    const der = crypto
      .createPublicKey(publicKeyPem!)
      .export({ format: 'der', type: 'spki' }) as Buffer
    const fp = crypto.createHash('sha256').update(der).digest('hex')
    keyId = fp.slice(0, 16)
  }
  return keyId!
}
