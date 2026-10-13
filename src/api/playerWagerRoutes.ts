import { createHash } from 'node:crypto'
import { Router, type Request } from 'express'
import type { Pool } from 'pg'
import { RaceState } from '../race/raceState.js'
import { NinesFinancialWagerClient, NinesFinancialWagerClientError } from '../financial/NinesFinancialWagerClient.js'
import { createNinesPlaceBetCommand, createTrustedPlayerIdentity, hashCanonicalJson } from '../financial/ninesPlaceBetContract.js'
import { verifyServiceMessage } from '../financial/serviceMessageAuthentication.js'

export const PLAYER_WAGER_PATH = '/internal/v1/player-wagers'
const PLAYER_WAGER_SCHEMA = 'nines-player-wager-request.v1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RACE_REF = /^N9-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/
const IDENTIFIER = /^[A-Za-z0-9:_-]{1,200}$/
const MINOR = /^[1-9][0-9]*$/

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

interface PlayerWagerRequest {
  schemaVersion: typeof PLAYER_WAGER_SCHEMA
  playerId: string
  raceRef: string
  selectionId: string
  stake: { currency: 'NINES'; scale: 6; minorUnits: string }
  idempotencyKey: string
  authenticatedAt: string
  correlationId: string
}

function deterministicUuid(value: string): string {
  const hex = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = 'a'
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`
}

function requiredHeader(request: Request, name: string): string {
  return request.header(name)?.trim() ?? ''
}

function parseRequest(value: unknown): PlayerWagerRequest | null {
  if (!value || typeof value !== 'object') return null
  const body = value as Partial<PlayerWagerRequest>
  if (body.schemaVersion !== PLAYER_WAGER_SCHEMA || !UUID.test(body.playerId ?? '') ||
      !RACE_REF.test(body.raceRef ?? '') || !IDENTIFIER.test(body.selectionId ?? '') ||
      !IDENTIFIER.test(body.idempotencyKey ?? '') || !IDENTIFIER.test(body.correlationId ?? '') ||
      !body.authenticatedAt || !Number.isFinite(Date.parse(body.authenticatedAt)) ||
      body.stake?.currency !== 'NINES' || body.stake.scale !== 6 ||
      !MINOR.test(body.stake.minorUnits ?? '')) return null
  return body as PlayerWagerRequest
}

export function createPlayerWagerRouter(options: {
  environment: 'development' | 'test' | 'production'
  apiKeyId: string
  apiSecret: string
  database: Pool
  financialClient: NinesFinancialWagerClient
  clock?: () => Date
}): Router {
  const router = Router()
  const clock = options.clock ?? (() => new Date())

  router.post(PLAYER_WAGER_PATH, async (request, response) => {
    const serviceId = requiredHeader(request, 'x-nines-service-id')
    const keyId = requiredHeader(request, 'x-nines-key-id')
    const requestId = requiredHeader(request, 'x-nines-request-id')
    const sentAt = requiredHeader(request, 'x-nines-sent-at')
    const contentHash = requiredHeader(request, 'x-nines-content-sha256')
    const signature = requiredHeader(request, 'x-nines-signature')
    const receivedAt = clock()
    const sentAtMs = Date.parse(sentAt)
    const bodyHash = hashCanonicalJson(request.body as Json)
    if (serviceId !== 'nines-api' || keyId !== options.apiKeyId || !UUID.test(requestId) ||
        !Number.isFinite(sentAtMs) || Math.abs(receivedAt.getTime() - sentAtMs) > 300_000 ||
        bodyHash !== contentHash || !verifyServiceMessage({ method: request.method,
          path: PLAYER_WAGER_PATH, environment: options.environment, serviceId, keyId,
          requestId, sentAt, contentHash, signature, secret: options.apiSecret })) {
      response.status(403).json({ error: { code: 'SERVICE_AUTH_FAILED', message: 'Service authentication failed' } })
      return
    }

    const input = parseRequest(request.body)
    if (!input) {
      response.status(400).json({ error: { code: 'INVALID_PLAYER_WAGER', message: 'Wager request is invalid' } })
      return
    }
    if (Date.parse(input.authenticatedAt) > receivedAt.getTime() ||
        receivedAt.getTime() - Date.parse(input.authenticatedAt) > 300_000) {
      response.status(403).json({ error: { code: 'PLAYER_ASSERTION_NOT_CURRENT', message: 'Player authentication is no longer current' } })
      return
    }

    try {
      await options.database.query(
        `insert into api_service_request_nonces (service_id,request_id,sent_at,received_at)
         values ($1,$2,$3,$4)`, [serviceId, requestId, new Date(sentAtMs), receivedAt])
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        response.status(409).json({ error: { code: 'SERVICE_REQUEST_REPLAY', message: 'Authenticated request was already received' } })
        return
      }
      response.status(503).json({
        error: { code: 'WAGER_GATEWAY_UNAVAILABLE', message: 'The wager could not be confirmed' },
      })
      return
    }

    const race = RaceState.findPrecomputedByRef(input.raceRef)
    if (!race || RaceState.getPrecomputedRace()?.raceId !== race.raceId) {
      response.status(409).json({ error: { code: 'RACE_NOT_CURRENT', message: 'The requested race is no longer current' } })
      return
    }
    if (!race.horses.some((horse) => horse.id === input.selectionId)) {
      response.status(400).json({ error: { code: 'INVALID_SELECTION', message: 'The selected runner is not in this race' } })
      return
    }

    try {
      const assertion = createTrustedPlayerIdentity({ playerId: input.playerId,
        authenticatedAt: input.authenticatedAt,
        expiresAt: new Date(Date.parse(input.authenticatedAt) + 300_000).toISOString() })
      const betId = deterministicUuid(`player-wager:${input.playerId}:${input.idempotencyKey}`)
      const economicCorrelationId = `wager:${betId}`
      const economicCausationId = `player-request:${betId}`
      const result = await options.financialClient.placeBet(createNinesPlaceBetCommand({
        environment: options.environment, betId, playerId: input.playerId,
        raceId: race.raceId, raceRef: race.raceRef, selectionId: input.selectionId,
        stakeMinor: input.stake.minorUnits, idempotencyKey: input.idempotencyKey,
        requestedAt: receivedAt.toISOString(), correlationId: economicCorrelationId,
        causationId: economicCausationId, playerIdentity: assertion,
      }))
      response.status(result.result === 'accepted' ? 201 : 200).json(result)
    } catch (error) {
      if (error instanceof NinesFinancialWagerClientError) {
        response.status(error.status && error.status < 500 ? 409 : 503).json({
          error: { code: error.code, message: 'The wager could not be confirmed', retryable: error.retryable },
        })
        return
      }
      const fingerprint = createHash('sha256').update(String(error)).digest('hex').slice(0, 16)
      response.status(500).json({ error: { code: 'WAGER_GATEWAY_ERROR', message: 'The wager could not be processed', fingerprint } })
    }
  })

  return router
}
