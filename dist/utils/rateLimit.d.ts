import type { Request, Response, NextFunction } from 'express';
export declare function rateLimit(opts: {
    windowMs: number;
    max: number;
}): (req: Request, res: Response, next: NextFunction) => Promise<void | Response<any, Record<string, any>>>;
