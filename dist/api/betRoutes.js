import { Router } from 'express';
import { getBetService } from '../services/betService.js';
import { ForbiddenError, NotFoundError, ValidationError, } from '../user/errors.js';
function readToken(req) {
    const headerToken = req.headers['x-api-token'];
    if (typeof headerToken === 'string')
        return headerToken;
    const queryToken = req.query['token'];
    return typeof queryToken === 'string' ? queryToken : null;
}
function requireApiToken(req, res, next) {
    if (process.env.REQUIRE_API_TOKEN !== '1')
        return next();
    const expected = process.env.API_TOKEN || '';
    const token = readToken(req);
    if (token && token === expected)
        return next();
    return res.status(401).json({ error: 'unauthorized' });
}
function parseAmountMinor(value) {
    if (typeof value === 'string' && /^-?\d+$/.test(value)) {
        return BigInt(value);
    }
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
        return BigInt(value);
    }
    throw new ValidationError('stakeMinor must be an integer string or safe integer');
}
function toBetResponse(bet) {
    return {
        id: bet.id,
        userId: bet.userId,
        walletId: bet.walletId,
        raceId: bet.raceId,
        currency: bet.currency,
        betType: bet.betType,
        selectionId: bet.selectionId,
        stakeMinor: bet.stakeMinor.toString(),
        payoutMinor: bet.payoutMinor === null ? null : bet.payoutMinor.toString(),
        status: bet.status,
        resultStatus: bet.resultStatus,
        placedAt: bet.placedAt,
        settledAt: bet.settledAt,
        refundedAt: bet.refundedAt,
        metadata: bet.metadata,
        createdAt: bet.createdAt,
        updatedAt: bet.updatedAt,
    };
}
function handleRouteError(error, res) {
    if (error instanceof ValidationError) {
        res.status(400).json({ error: error.message });
        return;
    }
    if (error instanceof ForbiddenError) {
        res.status(403).json({ error: error.message });
        return;
    }
    if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
        return;
    }
    res
        .status(500)
        .json({ error: error instanceof Error ? error.message : String(error) });
}
const router = Router();
const betService = getBetService();
router.post('/', requireApiToken, async (req, res) => {
    try {
        const placed = await betService.placeBet({
            userId: req.body?.userId,
            raceId: req.body?.raceId,
            selectionId: req.body?.selectionId,
            stakeMinor: parseAmountMinor(req.body?.stakeMinor),
            currency: req.body?.currency,
            metadata: req.body?.metadata,
        });
        return res.status(201).json({
            bet: toBetResponse(placed.bet),
            wallet: {
                id: placed.wallet.id,
                userId: placed.wallet.userId,
                currency: placed.wallet.currency,
                balanceMinor: placed.wallet.balanceMinor.toString(),
                createdAt: placed.wallet.createdAt,
                updatedAt: placed.wallet.updatedAt,
            },
            ledgerEntry: {
                id: placed.ledgerEntry.id,
                walletId: placed.ledgerEntry.walletId,
                entryType: placed.ledgerEntry.entryType,
                deltaMinor: placed.ledgerEntry.deltaMinor.toString(),
                balanceAfterMinor: placed.ledgerEntry.balanceAfterMinor.toString(),
                referenceType: placed.ledgerEntry.referenceType,
                referenceId: placed.ledgerEntry.referenceId,
                metadata: placed.ledgerEntry.metadata,
                createdAt: placed.ledgerEntry.createdAt,
            },
        });
    }
    catch (error) {
        handleRouteError(error, res);
    }
});
router.get('/:betId', requireApiToken, async (req, res) => {
    try {
        const bet = await betService.getBetById(req.params.betId);
        return res.json({ bet: toBetResponse(bet) });
    }
    catch (error) {
        handleRouteError(error, res);
    }
});
router.get('/', requireApiToken, async (req, res) => {
    try {
        const userId = req.query.userId;
        if (typeof userId !== 'string' || !userId) {
            throw new ValidationError('userId query parameter is required');
        }
        const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
        if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
            throw new ValidationError('limit must be a positive integer');
        }
        const bets = await betService.listBetsByUserId(userId, limit);
        return res.json({ bets: bets.map(toBetResponse) });
    }
    catch (error) {
        handleRouteError(error, res);
    }
});
export default router;
