# nines-back-end

                        ┌───────────────────┐
                        │   dotnet run      │
                        │ Program.cs boots  │
                        └───────────────────┘
                                  │
                                  ▼
             ┌────────────────────────────────────────┐
             │ 1. Application Startup (Program.cs)   │
             │  • Load appsettings.json → IConfiguration │
             │  • Configure<AppSettings> (Options)   │
             │  • Register Dependencies in DI        │
             │    - IRaceRepository → InMemoryRaceRepo │
             │    - IRaceService    → RaceService    │
             │    - IExchangeGateway → ExchangeGateway │
             │  • AddControllers(), Swagger, Middleware │
             └────────────────────────────────────────┘
                                  │
                                  ▼
             ┌────────────────────────────────────────┐
             │ 2. HTTP Server & Middleware Pipeline  │
             │  • HTTPS Redirection                  │
             │  • Routing                            │
             │  • Authorization                      │
             └────────────────────────────────────────┘
                                  │
                                  ▼
             ┌────────────────────────────────────────┐
             │ 3. Controller (handlers/webAPI)       │
             │    RaceController / BetController     │
             │  • [ApiController], [Route("api/...")]│
             │  • Model-bind incoming args / body    │
             │  • Call into Service layer            │
             │  • Return ActionResult<T>             │
             └────────────────────────────────────────┘
                                  │
                                  ▼
             ┌────────────────────────────────────────┐
             │ 4. Service Layer (Services/)          │
             │    IRaceService / RaceService         │
             │    IBetService  / BetService          │
             │  • Enforce business rules             │
             │  • Call into Repository(s) & Gateway  │
             │  • Map Domain Entities → DTOs         │
             └────────────────────────────────────────┘
                                  │
             ┌────────────────────────────────────────┐
             │ 5a. Repository (Domains/Repositories) │
             │    IRaceRepository → InMemoryRaceRepo │
             │    IBetRepository   → (e.g. EF Core)  │
             │  • CRUD against your DataStore        │
             │                                        │
             │ 5b. Gateway (Gateways/)               │
             │    IExchangeGateway → ExchangeGateway │
             │  • Call out to external services      │
             └────────────────────────────────────────┘
                                  │
                                  ▼
             ┌────────────────────────────────────────┐
             │ 6. Data Store / External API          │
             │  • In-Memory List (dev) or            │
             │    EF Core → SQL Server/Postgres      │
             │  • Third-party exchange REST calls    │
             └────────────────────────────────────────┘
                                  │
                                  ▼
             ┌────────────────────────────────────────┐
             │ 7. Response flows back up:            │
             │   Data → Repo/Gateway → Service       │
             │   Service → Controller → HTTP/JSON    │
             └────────────────────────────────────────┘
                                  │
                                  ▼
                        ┌───────────────────┐
                        │   Client receives │
                        │   JSON payload    │
                        └───────────────────┘

flowchart TD
subgraph HTTP Layer
A[Client HTTP Request]
B[Kestrel → ASP.NET Core Middleware]
C[Routing → Controller Selection]
end

subgraph API Layer
D[RaceController.cs]
end

subgraph Service Layer
E[RaceService.cs]
end

subgraph Domain Layer
F[IRaceRepository.cs]
G[InMemoryRaceRepository.cs]
H[Race.cs / Horse.cs]
end

subgraph DTO Layer
I[RaceDto.cs / HorseSummaryDto.cs]
end

subgraph HTTP Layer
J[HTTP Response → JSON]
end

A --> B --> C --> D
D --> E
E --> F
F --> G
G --> H
G --> E
E --> I
I --> D
D --> J

🚀 Phase 1: Core “race engine” (you’ve almost landed this)
Schema + EF Core

Tables: Horses, Races, RaceParticipants

Wire up GameDbContext, migrations, swap in your EfRaceRepository.

Scheduler & API

Minute-by-minute loop driving OpenBets, CloseBets, StartRace, RunRace, Reset.

Controllers returning RaceDto with finishTimes & winnerId.

Front-end integration

Poll or subscribe for status = InProgress

Fetch /api/race/next at :30 → animate horses → highlight the winner at :50

✔️ When this is done, you have a fully working “horse race” game end-to-end, all running on your DB.

💰 Phase 2: Betting & Crypto flows
This is the trickiest, so start research & prototypes in parallel to Phase 1:

Custodial vs. Trustless

Custodial: user deposits crypto into your on-chain or off-chain wallet → you manage bets/payouts centrally.

Trustless (smart-contract): bets go into a contract; an oracle writes your pre-computed result on-chain; contract auto-pays winners.

Wallet integration

Front-end: Metamask / WalletConnect login & eth_requestAccounts.

Back-end:

Custodial: generate deposit addresses, monitor on-chain events (via Infura/Alchemy/Web3).

Smart-contract: deploy a betting contract, craft transactions to place bets/payouts.

Fee flows

If custodial, deduct your fee before crediting bet pools.

If contract, embed a “house edge” in the payout formula.

Testnets first

Deploy to Rinkeby/Goerli, simulate bets & payouts, debug flows.

🔍 Study points:

How do casinos handle crypto deposits?

Chainlink oracles for off-chain result feeds

KYC/AML if you go custodial

👤 Phase 3: User & session management
Wallet-based auth

No passwords—user signs a nonce with their private key.

Server verifies signature, issues a JWT/session cookie.

Profile data

Optional email, display name, KYC status, balances.

🔧 Phase 4: Admin & monitoring
Admin UI

Dashboard: view ongoing races, total pools, manual overrides.

Audit logs

Table: RaceEvents, BetEvents with JSON payload.

Metrics & alerts

CloudWatch/Grafana dashboards for latency, errors, on-chain reorgs.

🧪 Phase 5: Testing
Unit tests for your service and repo logic.

Integration tests hitting the EF Core GameDbContext in-memory provider.

E2E tests (Cypress, Playwright) driving the front-end through a full minute cycle.

Load testing (Locust, k6) to simulate hundreds of bettors.

🚢 Phase 6: Deployment & CI/CD
Infra as Code (Terraform / AWS CDK) for RDS, ECS/Fargate or Lambda + API Gateway.

GitHub Actions or CodePipeline:

Build → Test → Migrate → Deploy to Staging → Manual Approval → Prod.

Terraform state stored in S3 + Dynamo / remote backend.

🔒 Phase 7: Security & hardening
OWASP Top 10: SQL-injection, XSS, CSRF, broken auth.

Secrets management: AWS Secrets Manager / Parameter Store for DB creds & private keys.

WAF / rate limiting on your API Gateway.

Penetration testing & third-party audits (esp. for any smart-contracts).

📅 Next steps
Finish Phase 1 today: EF Core + DB tables for Races, RaceParticipants, Horses and swap your in-memory repo for an EF-backed one.

Begin Phase 2 research: pick custodial vs. smart-contract. Prototype a deposit workflow on testnet.

Sketch Phase 3 auth flow.

This way you’ll have a running product (the race game) early, then layer on real money and user accounts once the mechanics are rock-solid. Let me know which part you’d like to dig into first!
