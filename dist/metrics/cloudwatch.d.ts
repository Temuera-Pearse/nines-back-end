export declare function initCloudWatch(): void;
export declare function pushMetrics(metrics: Array<{
    name: string;
    value: number;
}>): Promise<void>;
