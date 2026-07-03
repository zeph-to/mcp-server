import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HookResponseWaiter, type WsFactory, type WsLike } from './ws-wait.js';

// Scripted fake WebSocket — tests fire events by hand.
class FakeWs implements WsLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.emit('close', {}); }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  emit(type: string, event: { data?: unknown }): void {
    for (const l of this.listeners.get(type) ?? []) l(event);
  }
  open(): void { this.readyState = 1; this.emit('open', {}); }
}

let sockets: FakeWs[];
let urls: string[];
const factory: WsFactory = (url) => {
  urls.push(url);
  const s = new FakeWs();
  sockets.push(s);
  return s;
};

// NOTE: pass wsUrl explicitly — a default parameter would silently kick
// in when a test passes `undefined` on purpose.
const makeWaiter = (wsUrl?: string) =>
  new HookResponseWaiter({ wsUrl, apiKey: 'ak_test', factory });
const makeConnectedWaiter = () => makeWaiter('wss://ws.zeph.to');

beforeEach(() => {
  sockets = [];
  urls = [];
  vi.useRealTimers();
});

const settledFlag = (p: Promise<void>): { (): boolean } => {
  let settled = false;
  void p.then(() => { settled = true; });
  return () => settled;
};

const tick = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

describe('HookResponseWaiter', () => {
  it('cannot wait without a wsUrl', () => {
    expect(makeWaiter(undefined).canWait()).toBe(false);
  });

  it('cannot wait without a WebSocket implementation', () => {
    const waiter = new HookResponseWaiter({ wsUrl: 'wss://x', apiKey: 'ak' });
    // Node < 21 test environments have no global WebSocket; if this
    // runtime provides one the waiter may legitimately report true.
    const hasGlobal = typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'undefined';
    expect(waiter.canWait()).toBe(hasGlobal);
  });

  it('connects lazily with the apiKey in the query string', () => {
    const waiter = makeConnectedWaiter();
    expect(sockets).toHaveLength(0);
    waiter.subscribe('hevt_1');
    expect(sockets).toHaveLength(1);
    expect(urls[0]).toBe('wss://ws.zeph.to?apiKey=ak_test');
  });

  it('resolves the matching wait on hook.responded', async () => {
    const waiter = makeConnectedWaiter();
    const subA = waiter.subscribe('hevt_a');
    const subB = waiter.subscribe('hevt_b');
    const aSettled = settledFlag(subA.settled);
    const bSettled = settledFlag(subB.settled);

    sockets[0].open();
    sockets[0].emit('message', { data: JSON.stringify({ type: 'hook.responded', data: { eventId: 'hevt_a' } }) });
    await tick();

    expect(aSettled()).toBe(true);
    expect(bSettled()).toBe(false);
  });

  it('resolves on hook.cancelled too', async () => {
    const waiter = makeConnectedWaiter();
    const sub = waiter.subscribe('hevt_c');
    const settled = settledFlag(sub.settled);
    sockets[0].open();
    sockets[0].emit('message', { data: JSON.stringify({ type: 'hook.cancelled', data: { eventId: 'hevt_c' } }) });
    await tick();
    expect(settled()).toBe(true);
  });

  it('ignores unrelated and malformed frames', async () => {
    const waiter = makeConnectedWaiter();
    const sub = waiter.subscribe('hevt_d');
    const settled = settledFlag(sub.settled);
    sockets[0].open();
    sockets[0].emit('message', { data: JSON.stringify({ type: 'push.new', data: { eventId: 'hevt_d' } }) });
    sockets[0].emit('message', { data: '{broken' });
    sockets[0].emit('message', { data: JSON.stringify({ type: 'hook.responded', data: {} }) });
    await tick();
    expect(settled()).toBe(false);
  });

  it('reports connectivity transitions', () => {
    const waiter = makeConnectedWaiter();
    const sub = waiter.subscribe('hevt_e');
    expect(sub.isConnected()).toBe(false);
    sockets[0].open();
    expect(sub.isConnected()).toBe(true);
    sockets[0].emit('error', {});
    expect(sub.isConnected()).toBe(false);
  });

  it('reuses one socket across waits and closes it after idle', () => {
    vi.useFakeTimers();
    const waiter = makeConnectedWaiter();
    const subA = waiter.subscribe('hevt_a');
    const subB = waiter.subscribe('hevt_b');
    expect(sockets).toHaveLength(1);
    sockets[0].open();

    subA.dispose();
    vi.advanceTimersByTime(60_000);
    expect(sockets[0].closed).toBe(false); // subB still pending

    subB.dispose();
    vi.advanceTimersByTime(30_000);
    expect(sockets[0].closed).toBe(true);
  });

  it('a new subscribe after idle-close opens a fresh socket', () => {
    vi.useFakeTimers();
    const waiter = makeConnectedWaiter();
    waiter.subscribe('hevt_a').dispose();
    vi.advanceTimersByTime(30_000);
    expect(sockets[0].closed).toBe(true);

    waiter.subscribe('hevt_b');
    expect(sockets).toHaveLength(2);
  });

  it('sends app-level pings while open', () => {
    vi.useFakeTimers();
    const waiter = makeConnectedWaiter();
    waiter.subscribe('hevt_a');
    sockets[0].open();
    vi.advanceTimersByTime(25_000);
    expect(sockets[0].sent).toContain(JSON.stringify({ type: 'ping' }));
  });
});
