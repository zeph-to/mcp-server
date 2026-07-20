import { afterEach, describe, expect, it, vi } from 'vitest';

// Cross-repo contract: `listenerDeviceId()` MUST equal what cli
// `computeListenerDeviceId()` produces for the same machine, otherwise a
// `zeph_ask` hook lands in the Streams feed but never threads into the agent
// chat (the bug this test guards). It once regressed because this repo seeded
// the id from the hostname while cli seeded from the platform machine id.
//
// The golden constants are hardcoded so a change to EITHER the seed source or
// the hash breaks the test. cli/src/listener.test.ts asserts the same
// `dev_listener_a8d5d472` for the same machine seed.
const GOLDEN_MACHINE_ID = 'dev_listener_a8d5d472'; // dev_listener_<sha8('ZEPH-TEST-MACHINE-ID-0001')>
const GOLDEN_HOSTNAME = 'dev_listener_fb6ec4d5'; //   dev_listener_<sha8('zeph-test-host')>

const io = vi.hoisted(() => ({
    execFileSync: vi.fn(),
    readFileSync: vi.fn(),
    hostname: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('child_process')>()),
    execFileSync: (...args: unknown[]) => io.execFileSync(...args),
}));
vi.mock('fs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('fs')>()),
    readFileSync: (...args: unknown[]) => io.readFileSync(...args),
}));
vi.mock('os', async (importOriginal) => ({
    ...(await importOriginal<typeof import('os')>()),
    hostname: () => io.hostname(),
}));

afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
});

describe('listenerDeviceId (must match cli computeListenerDeviceId)', () => {
    it('hashes the platform machine id when one is readable', async () => {
        // Cover both platforms: macOS ioreg IOPlatformUUID + Linux /etc/machine-id.
        io.execFileSync.mockReturnValue('  "IOPlatformUUID" = "ZEPH-TEST-MACHINE-ID-0001"\n');
        io.readFileSync.mockImplementation((p: string) => {
            if (p === '/etc/machine-id') return 'ZEPH-TEST-MACHINE-ID-0001';
            throw new Error('ENOENT');
        });
        const { listenerDeviceId } = await import('./config.js');
        expect(listenerDeviceId()).toBe(GOLDEN_MACHINE_ID);
    });

    it('falls back to a hostname hash when no machine id or sticky file exists', async () => {
        io.execFileSync.mockImplementation(() => {
            throw new Error('no ioreg');
        });
        io.readFileSync.mockImplementation(() => {
            throw new Error('ENOENT');
        });
        io.hostname.mockReturnValue('zeph-test-host');
        const { listenerDeviceId } = await import('./config.js');
        expect(listenerDeviceId()).toBe(GOLDEN_HOSTNAME);
    });
});
