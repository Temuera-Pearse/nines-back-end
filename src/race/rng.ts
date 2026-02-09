import { createHash } from 'crypto'

export function makeSeededRng(seed: number) {
  // Split seed into 4 uint32 values for xorshift128
  let s0 = seed >>> 0
  let s1 = (seed ^ 0xdeadbeef) >>> 0
  let s2 = (seed ^ 0x12345678) >>> 0
  let s3 = (seed ^ 0xcafebabe) >>> 0

  return () => {
    let t = s1 << 9
    let r = s0 ^ t
    s0 = s1
    s1 = s2
    s2 = s3
    s3 = s3 ^ (s3 >>> 11) ^ (r ^ (r >>> 8))
    return (s3 >>> 0) / 0x100000000
  }
}

export function makeMulberry32(seed: number) {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), t | 1)
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

export function hashStringToInt(str: string): number {
  const hash = createHash('sha256').update(str).digest()
  // take first 4 bytes as unsigned 32-bit int
  return ((hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3]) >>> 0
}
