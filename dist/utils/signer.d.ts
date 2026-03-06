export declare function isSigningEnabled(): boolean;
export declare function signBytesAsync(data: Buffer): Promise<string>;
export declare function signBytes(data: Buffer): string;
export declare function getPublicKeyAsync(): Promise<string>;
export declare function getPublicKey(): string;
export declare function getPublicKeyIdAsync(): Promise<string>;
export declare function getPublicKeyId(): string;
