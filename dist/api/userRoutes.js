import { Router } from 'express';
import { getUserService } from '../services/userService.js';
import { getWalletService } from '../services/walletService.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, } from '../user/errors.js';
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
function requireAdminApiToken(req, res, next) {
    const expected = process.env.ADMIN_API_TOKEN || process.env.API_TOKEN || '';
    if (!expected && process.env.REQUIRE_API_TOKEN !== '1')
        return next();
    const token = readToken(req);
    if (token && token === expected)
        return next();
    return res.status(401).json({ error: 'unauthorized' });
}
function toUserResponse(user) {
    return {
        id: user.id,
        username: user.username,
        email: user.email,
        accountStatus: user.accountStatus,
        dateOfBirth: user.dateOfBirth,
        ageVerificationStatus: user.ageVerificationStatus,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
    };
}
function toWalletResponse(wallet) {
    return {
        id: wallet.id,
        userId: wallet.userId,
        currency: wallet.currency,
        balanceMinor: wallet.balanceMinor.toString(),
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
    };
}
function parseAmountMinor(value) {
    if (typeof value === 'string' && /^-?\d+$/.test(value)) {
        return BigInt(value);
    }
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
        return BigInt(value);
    }
    throw new ValidationError('amountMinor must be an integer string or safe integer');
}
function handleRouteError(error, res) {
    if (error instanceof ValidationError) {
        res.status(400).json({ error: error.message });
        return;
    }
    if (error instanceof ConflictError) {
        res.status(409).json({ error: error.message });
        return;
    }
    if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
        return;
    }
    if (error instanceof ForbiddenError) {
        res.status(403).json({ error: error.message });
        return;
    }
    res
        .status(500)
        .json({ error: error instanceof Error ? error.message : String(error) });
}
const router = Router();
const userService = getUserService();
const walletService = getWalletService();
router.post('/', requireApiToken, async (req, res) => {
    try {
        const created = await userService.createUser({
            username: req.body?.username,
            email: req.body?.email,
            dateOfBirth: req.body?.dateOfBirth,
            currency: req.body?.currency,
        });
        return res.status(201).json({
            user: toUserResponse(created.user),
            wallet: toWalletResponse(created.wallet),
        });
    }
    catch (error) {
        handleRouteError(error, res);
    }
});
router.get('/:userId', requireApiToken, async (req, res) => {
    try {
        const user = await userService.getUserById(req.params.userId);
        const eligibility = await userService.getBetEligibility(req.params.userId);
        return res.json({
            user: toUserResponse(user),
            betEligibility: eligibility,
        });
    }
    catch (error) {
        handleRouteError(error, res);
    }
});
router.get('/:userId/wallet', requireApiToken, async (req, res) => {
    try {
        const wallet = await walletService.getWalletByUserId(req.params.userId, typeof req.query.currency === 'string' ? req.query.currency : undefined);
        return res.json({ wallet: toWalletResponse(wallet) });
    }
    catch (error) {
        handleRouteError(error, res);
    }
});
router.post('/:userId/wallet/credits', requireAdminApiToken, async (req, res) => {
    try {
        const entryType = (req.body?.entryType ||
            'admin_credit');
        const adjusted = await walletService.creditWallet({
            userId: req.params.userId,
            amountMinor: parseAmountMinor(req.body?.amountMinor),
            currency: req.body?.currency,
            entryType,
            referenceType: req.body?.referenceType,
            referenceId: req.body?.referenceId,
            metadata: req.body?.metadata,
        });
        return res.status(201).json({
            wallet: toWalletResponse(adjusted.wallet),
            ledgerEntry: {
                id: adjusted.ledgerEntry.id,
                walletId: adjusted.ledgerEntry.walletId,
                entryType: adjusted.ledgerEntry.entryType,
                deltaMinor: adjusted.ledgerEntry.deltaMinor.toString(),
                balanceAfterMinor: adjusted.ledgerEntry.balanceAfterMinor.toString(),
                referenceType: adjusted.ledgerEntry.referenceType,
                referenceId: adjusted.ledgerEntry.referenceId,
                metadata: adjusted.ledgerEntry.metadata,
                createdAt: adjusted.ledgerEntry.createdAt,
            },
        });
    }
    catch (error) {
        handleRouteError(error, res);
    }
});
router.patch('/:userId/status', requireAdminApiToken, async (req, res) => {
    try {
        const accountStatus = req.body?.accountStatus;
        const user = await userService.updateAccountStatus({
            userId: req.params.userId,
            accountStatus,
        });
        return res.json({ user: toUserResponse(user) });
    }
    catch (error) {
        handleRouteError(error, res);
    }
});
router.patch('/:userId/age-verification', requireAdminApiToken, async (req, res) => {
    try {
        const ageVerificationStatus = req.body
            ?.ageVerificationStatus;
        const user = await userService.updateAgeVerificationStatus({
            userId: req.params.userId,
            ageVerificationStatus,
        });
        return res.json({ user: toUserResponse(user) });
    }
    catch (error) {
        handleRouteError(error, res);
    }
});
export default router;
