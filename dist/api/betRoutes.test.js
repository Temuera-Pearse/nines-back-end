import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { betServiceMock } = vi.hoisted(() => ({
    betServiceMock: {
        placeBet: vi.fn(async () => ({
            bet: {
                id: 'bet-1',
                userId: 'user-1',
                walletId: 'wallet-1',
                raceId: 'race-1',
                currency: 'USD',
                betType: 'win',
                selectionId: 'horse-3',
                stakeMinor: 1200n,
                payoutMinor: null,
                status: 'placed',
                resultStatus: 'pending',
                placedAt: new Date('2026-03-22T00:00:00.000Z'),
                settledAt: null,
                refundedAt: null,
                metadata: { source: 'route-test' },
                createdAt: new Date('2026-03-22T00:00:00.000Z'),
                updatedAt: new Date('2026-03-22T00:00:00.000Z'),
            },
            wallet: {
                id: 'wallet-1',
                userId: 'user-1',
                currency: 'USD',
                balanceMinor: 3800n,
                createdAt: new Date('2026-03-22T00:00:00.000Z'),
                updatedAt: new Date('2026-03-22T00:00:00.000Z'),
            },
            ledgerEntry: {
                id: 3,
                walletId: 'wallet-1',
                entryType: 'bet_stake',
                deltaMinor: -1200n,
                balanceAfterMinor: 3800n,
                referenceType: 'bet',
                referenceId: 'bet-1',
                metadata: { raceId: 'race-1', selectionId: 'horse-3' },
                createdAt: new Date('2026-03-22T00:00:00.000Z'),
            },
        })),
        getBetById: vi.fn(async () => ({
            id: 'bet-1',
            userId: 'user-1',
            walletId: 'wallet-1',
            raceId: 'race-1',
            currency: 'USD',
            betType: 'win',
            selectionId: 'horse-3',
            stakeMinor: 1200n,
            payoutMinor: null,
            status: 'placed',
            resultStatus: 'pending',
            placedAt: new Date('2026-03-22T00:00:00.000Z'),
            settledAt: null,
            refundedAt: null,
            metadata: {},
            createdAt: new Date('2026-03-22T00:00:00.000Z'),
            updatedAt: new Date('2026-03-22T00:00:00.000Z'),
        })),
        listBetsByUserId: vi.fn(async () => [
            {
                id: 'bet-1',
                userId: 'user-1',
                walletId: 'wallet-1',
                raceId: 'race-1',
                currency: 'USD',
                betType: 'win',
                selectionId: 'horse-3',
                stakeMinor: 1200n,
                payoutMinor: null,
                status: 'placed',
                resultStatus: 'pending',
                placedAt: new Date('2026-03-22T00:00:00.000Z'),
                settledAt: null,
                refundedAt: null,
                metadata: {},
                createdAt: new Date('2026-03-22T00:00:00.000Z'),
                updatedAt: new Date('2026-03-22T00:00:00.000Z'),
            },
        ]),
    },
}));
vi.mock('../services/betService.js', () => ({
    getBetService: () => betServiceMock,
}));
import betRoutes from './betRoutes.js';
function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/bets', betRoutes);
    return app;
}
let savedEnv;
beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.REQUIRE_API_TOKEN = '0';
    delete process.env.API_TOKEN;
});
afterEach(() => {
    process.env = savedEnv;
    vi.restoreAllMocks();
});
describe('betRoutes', () => {
    it('places a bet', async () => {
        const res = await request(makeApp()).post('/bets').send({
            userId: 'user-1',
            raceId: 'race-1',
            selectionId: 'horse-3',
            stakeMinor: '1200',
            currency: 'USD',
        });
        expect(res.status).toBe(201);
        expect(res.body.bet.id).toBe('bet-1');
        expect(res.body.wallet.balanceMinor).toBe('3800');
        expect(res.body.ledgerEntry.deltaMinor).toBe('-1200');
    });
    it('returns a bet by id', async () => {
        const res = await request(makeApp()).get('/bets/bet-1');
        expect(res.status).toBe(200);
        expect(res.body.bet.selectionId).toBe('horse-3');
    });
    it('lists bets for a user', async () => {
        const res = await request(makeApp()).get('/bets').query({ userId: 'user-1' });
        expect(res.status).toBe(200);
        expect(res.body.bets).toHaveLength(1);
        expect(res.body.bets[0].stakeMinor).toBe('1200');
    });
    it('requires api token when configured', async () => {
        process.env.REQUIRE_API_TOKEN = '1';
        process.env.API_TOKEN = 'alpha-token';
        const res = await request(makeApp()).post('/bets').send({
            userId: 'user-1',
            raceId: 'race-1',
            selectionId: 'horse-3',
            stakeMinor: '1200',
        });
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: 'unauthorized' });
    });
});
