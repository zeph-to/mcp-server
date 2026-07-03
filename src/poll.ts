import type { ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import type { ZephApiClient } from './api-client.js';
import type { HookEventResponse } from './types.js';
import type { HookResponseWaiter, WaitSubscription } from './ws-wait.js';

export interface PollContext {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: ServerNotification) => Promise<void>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const PROGRESS_INTERVAL_SECONDS = 5;

// While the WS fast path is live, polling is only the consistency
// backstop — 10s is plenty. The WS wake races the sleep, so a live
// answer still lands in sub-second time (SPEC-AGENT-AWARENESS §S3).
const WS_BACKSTOP_INTERVAL_MS = 10_000;
// After a WS wake, REST may briefly still read 'pending' (DDB eventual
// consistency) — retry tightly but boundedly.
const POST_WAKE_RETRY_MS = 500;

export const pollForResponse = async (
  client: ZephApiClient,
  hookId: string,
  eventId: string,
  timeoutSeconds: number,
  ctx: PollContext,
  waiter?: HookResponseWaiter,
): Promise<HookEventResponse | null> => {
  const progressToken = ctx._meta?.progressToken;
  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1000;
  let attempt = 0;
  let lastProgressAt = 0;

  let sub: WaitSubscription | undefined;
  let wsSettled = false;
  if (waiter?.canWait()) {
    sub = waiter.subscribe(eventId);
    void sub.settled.then(() => { wsSettled = true; });
  }

  try {

    while (Date.now() - startTime < timeoutMs) {
      const event = await client.getHookEvent(hookId, eventId);

      if (event.data.status === 'responded') return event;
      if (event.data.status === 'cancelled') throw new Error('User cancelled the request');
      if (event.data.status === 'timed_out') return null;
      // Only 'pending' should keep us polling. Anything else is server
      // contract drift — fail fast instead of spinning until the timeout.
      if (event.data.status !== 'pending') {
        throw new Error(`Unexpected hook event status: ${String(event.data.status)}`);
      }

      // Throttled progress notification (every 5s)
      if (progressToken !== undefined) {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        if (elapsed - lastProgressAt >= PROGRESS_INTERVAL_SECONDS) {
          lastProgressAt = elapsed;
          await ctx.sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: elapsed,
              total: timeoutSeconds,
              message: `Waiting for user response... (${elapsed}s / ${timeoutSeconds}s)`,
            },
          });
        }
      }

      if (wsSettled) {
        // Server said settled but this read still saw 'pending' —
        // eventual consistency. Tight bounded retry until reads agree.
        await sleep(POST_WAKE_RETRY_MS);
        attempt++;
        continue;
      }

      // Adaptive interval: poll every 1s while the user is likely still at
      // their device (first ~60 attempts ≈ 1 min), then back off to 3s for
      // long waits. The tight 1s window keeps post-tap detection snappy.
      // With a live WS subscription the cadence relaxes to a backstop and
      // the wake race handles snappiness instead.
      const interval = sub?.isConnected()
        ? WS_BACKSTOP_INTERVAL_MS
        : (attempt < 60 ? 1000 : 3000);
      await Promise.race([sleep(interval), sub?.settled ?? new Promise<void>(() => undefined)]);
      attempt++;
    }

    return null;
  } finally {
    sub?.dispose();
  }
};
