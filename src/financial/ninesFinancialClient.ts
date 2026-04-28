import { CANONICAL_FRONT_OF_HOUSE_CURRENCY } from './legacyAlphaFinancialAuthority.js'

export type MinorUnitString = string
export type FinancialCurrency = typeof CANONICAL_FRONT_OF_HOUSE_CURRENCY

export interface FinancialCommandMetadata {
  idempotencyKey: string
  correlationId: string
  causationId: string
}

export interface ReserveStakeCommand extends FinancialCommandMetadata {
  userId: string
  betId: string
  raceId: string
  selectionId: string
  stakeMinor: MinorUnitString
  currency: FinancialCurrency
}

export interface ReserveStakeResult {
  reservationId: string
  acceptedAt: string
}

export interface ReleaseReservationCommand extends FinancialCommandMetadata {
  reservationId: string
  reasonCode: string
}

export interface ReleaseReservationResult {
  reservationId: string
  releasedAt: string
}

export interface SettleBetCommand extends FinancialCommandMetadata {
  raceId: string
  winningSelectionId: string
  acceptedBets: readonly SettlementAcceptedBet[]
  totalPoolMinor: MinorUnitString
  houseTakeBps: number
  currency: FinancialCurrency
}

export interface SettlementAcceptedBet {
  betId: string
  userId: string
  selectionId: string
  stakeMinor: MinorUnitString
}

export interface SettledBetFinancialResult {
  betId: string
  userId: string
  selectionId: string
  resultStatus: 'won' | 'lost' | 'void'
  stakeMinor: MinorUnitString
  payoutMinor: MinorUnitString
  captureTransactionId: string
  payoutTransactionId: string | null
}

export interface SettleBetResult {
  raceId: string
  winningSelectionId: string
  totalPoolMinor: MinorUnitString
  houseTakeMinor: MinorUnitString
  netPoolMinor: MinorUnitString
  roundingResidualMinor: MinorUnitString
  settledBets: readonly SettledBetFinancialResult[]
  settledAt: string
}

export interface ApplyHouseTakeCommand extends FinancialCommandMetadata {
  raceId: string
  amountMinor: MinorUnitString
  currency: FinancialCurrency
}

export interface ApplyHouseTakeResult {
  raceId: string
  amountMinor: MinorUnitString
  appliedAt: string
}

export interface PlayerBalance {
  playerAccountId: string
  currency: FinancialCurrency
  spendableBalanceMinor: MinorUnitString
  lockedBalanceMinor: MinorUnitString
  restrictedBalanceMinor: MinorUnitString
  displayBalanceMinor: MinorUnitString
  asOf: string
}

export interface PlayerAccountSummary {
  playerAccountId: string
  userId: string
  currency: FinancialCurrency
  effectiveStatus: 'active' | 'restricted' | 'suspended' | 'frozen'
  displayBalanceMinor: MinorUnitString
  spendableBalanceMinor: MinorUnitString
  asOf: string
}

export interface NinesFinancialClient {
  reserveStake(command: ReserveStakeCommand): Promise<ReserveStakeResult>
  releaseReservation(
    command: ReleaseReservationCommand,
  ): Promise<ReleaseReservationResult>
  settleBet(command: SettleBetCommand): Promise<SettleBetResult>
  applyHouseTake(
    command: ApplyHouseTakeCommand,
  ): Promise<ApplyHouseTakeResult>
  getPlayerBalance(userId: string): Promise<PlayerBalance>
  getPlayerAccountSummary(userId: string): Promise<PlayerAccountSummary>
}

export class NinesFinancialClientConfigurationError extends Error {
  constructor() {
    super(
      'NINES_FINANCIAL_BASE_URL is required for backend financial authority commands',
    )
    this.name = 'NinesFinancialClientConfigurationError'
  }
}

export class NinesFinancialCommandError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: unknown,
  ) {
    super(message)
    this.name = 'NinesFinancialCommandError'
  }
}

export class HttpNinesFinancialClient implements NinesFinancialClient {
  constructor(private readonly baseUrl: string | undefined) {}

  reserveStake(command: ReserveStakeCommand): Promise<ReserveStakeResult> {
    return this.post('/commands/reserve-stake', command)
  }

  releaseReservation(
    command: ReleaseReservationCommand,
  ): Promise<ReleaseReservationResult> {
    return this.post('/commands/release-reservation', command)
  }

  settleBet(command: SettleBetCommand): Promise<SettleBetResult> {
    return this.post('/commands/settle-bet', command)
  }

  applyHouseTake(
    command: ApplyHouseTakeCommand,
  ): Promise<ApplyHouseTakeResult> {
    return this.post('/commands/apply-house-take', command)
  }

  getPlayerBalance(userId: string): Promise<PlayerBalance> {
    return this.get(`/player/accounts/${encodeURIComponent(userId)}/USDC/balance`)
  }

  getPlayerAccountSummary(userId: string): Promise<PlayerAccountSummary> {
    return this.get(`/player/accounts/${encodeURIComponent(userId)}/USDC`)
  }

  private async post<TResponse>(
    path: string,
    body: FinancialCommandMetadata,
  ): Promise<TResponse> {
    return this.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': body.idempotencyKey,
        'x-correlation-id': body.correlationId,
        'x-causation-id': body.causationId,
      },
      body: JSON.stringify(body),
    })
  }

  private async get<TResponse>(path: string): Promise<TResponse> {
    return this.request(path, { method: 'GET' })
  }

  private async request<TResponse>(
    path: string,
    init: RequestInit,
  ): Promise<TResponse> {
    if (!this.baseUrl?.trim()) {
      throw new NinesFinancialClientConfigurationError()
    }

    const response = await fetch(new URL(path, this.baseUrl), init)
    const responseBody = await this.parseResponseBody(response)

    if (!response.ok) {
      throw new NinesFinancialCommandError(
        `nines-financial command failed with HTTP ${response.status}`,
        response.status,
        responseBody,
      )
    }

    return responseBody as TResponse
  }

  private async parseResponseBody(response: Response): Promise<unknown> {
    const text = await response.text()

    if (!text) {
      return null
    }

    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }
}

let sharedClient: NinesFinancialClient | null = null

export function getNinesFinancialClient(): NinesFinancialClient {
  if (!sharedClient) {
    sharedClient = new HttpNinesFinancialClient(
      process.env.NINES_FINANCIAL_BASE_URL,
    )
  }

  return sharedClient
}
