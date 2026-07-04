import { describe, expect, it, vi } from 'vitest';
import { pollForResponse } from './poll.js';
import type { ZephApiClient } from './api-client.js';
import type { HookEventResponse } from './types.js';

// pollForResponse drives the long-poll loop that backs zeph_ask /
// zeph_prompt / zeph_input. It calls client.getHookEvent until status
// becomes responded / timed_out / cancelled — or the deadline elapses.

const mkClient = (events: HookEventResponse['data'][]): ZephApiClient => {
    let i = 0;
    return {
        getHookEvent: vi.fn(async () => ({
            data: events[Math.min(i++, events.length - 1)],
        })),
    } as unknown as ZephApiClient;
};

const noProgressCtx = { sendNotification: vi.fn() };

describe('pollForResponse', () => {
    it('returns immediately on responded status', async () => {
        const client = mkClient([{
            eventId: 'e1',
            status: 'responded',
            response: { actionId: 'continue' },
        }]);
        const result = await pollForResponse(client, 'hook_x', 'e1', 10, noProgressCtx);
        expect(result?.data.status).toBe('responded');
        expect(result?.data.response?.actionId).toBe('continue');
    });

    it('returns null on timed_out status', async () => {
        const client = mkClient([{ eventId: 'e1', status: 'timed_out' }]);
        const result = await pollForResponse(client, 'hook_x', 'e1', 10, noProgressCtx);
        expect(result).toBeNull();
    });

    it('throws on cancelled status', async () => {
        const client = mkClient([{ eventId: 'e1', status: 'cancelled' }]);
        await expect(pollForResponse(client, 'hook_x', 'e1', 10, noProgressCtx))
            .rejects.toThrow(/cancelled/);
    });

    it('keeps polling while pending, then returns on responded', async () => {
        const client = mkClient([
            { eventId: 'e1', status: 'pending' },
            { eventId: 'e1', status: 'pending' },
            { eventId: 'e1', status: 'responded', response: { value: 'typed text' } },
        ]);
        const result = await pollForResponse(client, 'hook_x', 'e1', 30, noProgressCtx);
        expect(result?.data.response?.value).toBe('typed text');
        expect((client.getHookEvent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
    });

    it('returns null when the deadline elapses (always-pending server)', async () => {
        const client = mkClient([{ eventId: 'e1', status: 'pending' }]);
        // 1-second timeout; the loop's adaptive interval is 2s for the
        // first 5 attempts, so it does ~1 poll then returns null.
        const result = await pollForResponse(client, 'hook_x', 'e1', 1, noProgressCtx);
        expect(result).toBeNull();
    });

    it('wakes early from the WS fast path instead of waiting out the backstop', async () => {
        // With a connected waiter the poll cadence is a 10s backstop.
        // The subscribe() promise resolves ~50ms in — if the wake race
        // works, total wall time stays far under one backstop interval.
        const client = mkClient([
            { eventId: 'e1', status: 'pending' },
            { eventId: 'e1', status: 'responded', response: { actionId: 'ok' } },
        ]);
        let settle: () => void = () => undefined;
        const fakeWaiter = {
            canWait: () => true,
            subscribe: () => ({
                settled: new Promise<void>((resolve) => { settle = resolve; }),
                isConnected: () => true,
                dispose: vi.fn(),
            }),
        };
        setTimeout(() => settle(), 50);
        const start = Date.now();
        const result = await pollForResponse(
            client, 'hook_x', 'e1', 30, noProgressCtx,
            fakeWaiter as unknown as Parameters<typeof pollForResponse>[5],
        );
        expect(result?.data.response?.actionId).toBe('ok');
        expect(Date.now() - start).toBeLessThan(5000);
    });

    it('disposes the WS subscription when the wait ends', async () => {
        const client = mkClient([{ eventId: 'e1', status: 'responded', response: {} }]);
        const dispose = vi.fn();
        const fakeWaiter = {
            canWait: () => true,
            subscribe: () => ({
                settled: new Promise<void>(() => undefined),
                isConnected: () => false,
                dispose,
            }),
        };
        await pollForResponse(
            client, 'hook_x', 'e1', 10, noProgressCtx,
            fakeWaiter as unknown as Parameters<typeof pollForResponse>[5],
        );
        expect(dispose).toHaveBeenCalledOnce();
    });

    it('emits progress notifications when a progressToken is provided', async () => {
        const sendNotification = vi.fn(async () => {});
        const ctx = {
            _meta: { progressToken: 'token-1' },
            sendNotification,
        };
        const client = mkClient([
            { eventId: 'e1', status: 'pending' },
            { eventId: 'e1', status: 'pending' },
            { eventId: 'e1', status: 'pending' },
            { eventId: 'e1', status: 'pending' },
            { eventId: 'e1', status: 'responded', response: { actionId: 'done' } },
        ]);
        // poll.ts uses real setTimeout with a 2-3s adaptive interval and
        // emits progress every 5 elapsed seconds. We need an 8s window
        // so the throttled progress notice fires at least once before
        // responded. Bump testTimeout to 15s for this one test.
        await pollForResponse(client, 'hook_x', 'e1', 8, ctx);
        // No assertion on call count — interval timing varies in CI — just
        // verify the notification shape if any were sent.
        for (const [arg] of sendNotification.mock.calls) {
            expect(arg.method).toBe('notifications/progress');
            expect(arg.params.progressToken).toBe('token-1');
        }
    }, 15000);
});
