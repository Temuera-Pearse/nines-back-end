/**
 * WebSocket server for real-time race updates
 */
export declare class RaceWebSocketServer {
    private static wss;
    private static clients;
    private static droppedTickFrames;
    private static bufferedAmountRing;
    private static bufferedAmountRingCap;
    private static role;
    static init(server: any): void;
    static setRole(role: 'leader' | 'edge'): void;
    static broadcast(message: any): void;
}
