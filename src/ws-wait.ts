/**
 * WebSocket fast path for hook-response waits (SPEC-AGENT-AWARENESS §S3).
 *
 * The server broadcasts `hook.responded` / `hook.cancelled` the moment
 * the user answers. This module subscribes to that feed so a wait can
 * wake instantly instead of sitting out its poll interval.
 *
 * Trust model: the WS message is a WAKE-UP SIGNAL ONLY. The poll loop
 * remains the single source of truth — on wake it immediately re-reads
 * the event over REST and acts on that. A spoofed/garbled/duplicated
 * frame can therefore cost at most one extra GET, never a wrong answer.
 * The same property makes degradation trivial: no WebSocket global
 * (Node < 21), no wsUrl configured, or a dropped socket all just mean
 * "nobody wakes us early" and the existing poll cadence carries on.
 *
 * Connection lifecycle: lazy connect on first subscribe, shared across
 * concurrent waits, app-level ping every 25 s (API GW $default route
 * answers 'pong'; native WebSocket has no protocol-ping API), closed
 * 30 s after the last pending wait ends.
 */

// Minimal structural view of the WHATWG WebSocket — lets tests inject a
// fake without the DOM lib, and prod code use globalThis.WebSocket.
export interface WsLike {
    readyState: number;
    send(data: string): void;
    close(): void;
    addEventListener(type: string, listener: (event: { data?: unknown; }) => void): void;
}

export type WsFactory = (url: string) => WsLike;

const WS_OPEN = 1;
const PING_INTERVAL_MS = 25_000;
const IDLE_CLOSE_MS = 30_000;

export interface WaitSubscription {
    /** Resolves when the server says this event settled (answer or cancel). */
    settled: Promise<void>;
    /** Live socket right now? Drives the caller's poll cadence. */
    isConnected(): boolean;
    dispose(): void;
}

export interface HookResponseWaiterOptions {
    wsUrl?: string;
    apiKey: string;
    /** Test seam. Defaults to globalThis.WebSocket when present. */
    factory?: WsFactory;
}

const defaultFactory = (): WsFactory | undefined => {
    const WS = (globalThis as { WebSocket?: new (url: string) => WsLike }).WebSocket;
    if (!WS) return undefined;
    return (url) => new WS(url);
};

export class HookResponseWaiter {
    private readonly wsUrl?: string;
    private readonly apiKey: string;
    private readonly factory?: WsFactory;
    private sock: WsLike | null = null;
    private connected = false;
    private readonly pending = new Map<string, () => void>();
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(opts: HookResponseWaiterOptions) {
        this.wsUrl = opts.wsUrl;
        this.apiKey = opts.apiKey;
        this.factory = opts.factory ?? defaultFactory();
    }

    /** False when the fast path can't exist — caller skips subscribe(). */
    canWait(): boolean {
        return !!this.wsUrl && !!this.factory;
    }

    subscribe(eventId: string): WaitSubscription {
        let resolveSettled: () => void = () => undefined;
        const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
        this.pending.set(eventId, resolveSettled);
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        this.ensureSocket();
        return {
            settled,
            isConnected: () => this.connected,
            dispose: () => {
                this.pending.delete(eventId);
                if (this.pending.size === 0) this.scheduleIdleClose();
            },
        };
    }

    private ensureSocket(): void {
        if (this.sock || !this.wsUrl || !this.factory) return;
        try {
            const sep = this.wsUrl.includes('?') ? '&' : '?';
            const sock = this.factory(`${this.wsUrl}${sep}apiKey=${encodeURIComponent(this.apiKey)}`);
            this.sock = sock;
            sock.addEventListener('open', () => {
                this.connected = true;
                this.pingTimer = setInterval(() => {
                    try {
                        if (sock.readyState === WS_OPEN) sock.send(JSON.stringify({ type: 'ping' }));
                    } catch { /* socket died mid-send — close handler cleans up */ }
                }, PING_INTERVAL_MS);
                // MCP servers are short-lived child processes; an unref'd
                // timer must not keep one alive after stdio closes.
                (this.pingTimer as { unref?: () => void }).unref?.();
            });
            sock.addEventListener('message', (event) => this.handleMessage(event.data));
            const drop = (): void => this.teardownSocket();
            sock.addEventListener('close', drop);
            sock.addEventListener('error', drop);
        } catch {
            this.teardownSocket();
        }
    }

    private handleMessage(data: unknown): void {
        if (typeof data !== 'string') return;
        try {
            const msg = JSON.parse(data) as { type?: string; data?: { eventId?: string } };
            if (msg.type !== 'hook.responded' && msg.type !== 'hook.cancelled') return;
            const eventId = msg.data?.eventId;
            if (typeof eventId !== 'string') return;
            // Resolve-and-keep: the poll loop confirms over REST and then
            // disposes; resolving a missing id is a no-op by design.
            this.pending.get(eventId)?.();
        } catch {
            /* non-JSON frame — ignore */
        }
    }

    private scheduleIdleClose(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.teardownSocket(), IDLE_CLOSE_MS);
        (this.idleTimer as { unref?: () => void }).unref?.();
    }

    private teardownSocket(): void {
        this.connected = false;
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        const sock = this.sock;
        this.sock = null;
        try { sock?.close(); } catch { /* already closed */ }
        // Pending waits stay pending — they simply lose the fast path and
        // their poll loops (which check isConnected) tighten back up.
    }
}
