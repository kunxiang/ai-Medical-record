// m2-99 B8:appendJournal 必须保留调用方提供的 event_id，不能破坏弱网重放幂等。
import { beforeAll, describe, expect, it, vi } from 'vitest';

const appendJsonl = vi.fn(async () => undefined);
vi.mock('../src/s3.js', () => ({ appendJsonl }));

describe('appendJournal idempotency identity', () => {
  beforeAll(() => {
    process.env.AUTH_SECRET = 'test-auth-secret-that-is-at-least-32-bytes';
  });

  it('B8 原样写出调用方 event_id', async () => {
    const { appendJournal } = await import('../src/journal.js');
    const eventId = '018f0000-0000-7000-8000-000000000001';
    const tx = { execute: vi.fn(async () => undefined) };

    await appendJournal(tx as never, 'p23456', {
      schema_version: '1.0',
      event: 'document_archive',
      event_id: eventId,
      at: '2026-08-27T00:00:00.000Z',
      by_account_id: '018f0000-0000-7000-8000-000000000002',
      client_operation_id: '018f0000-0000-7000-8000-000000000003',
      document_short_id: 'd23456',
      archived: true,
      reason: '验收事件',
    });

    expect(appendJsonl).toHaveBeenCalledTimes(1);
    const line = appendJsonl.mock.calls[0]![1] as string;
    expect(JSON.parse(line).event_id).toBe(eventId);
  });
});
