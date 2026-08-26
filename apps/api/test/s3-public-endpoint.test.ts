import { beforeAll, describe, expect, it } from 'vitest';

describe('S3 public presigning endpoint', () => {
  beforeAll(() => {
    process.env.AUTH_SECRET = 'test-auth-secret-that-is-at-least-32-bytes';
    process.env.S3_ENDPOINT = 'http://minio:9000';
    process.env.S3_PUBLIC_ENDPOINT = 'https://s3.medireco.eckstein.pro';
    process.env.S3_BUCKET = 'medical-record';
    process.env.S3_REGION = 'us-east-1';
    process.env.S3_ACCESS_KEY = 'test-access-key';
    process.env.S3_SECRET_KEY = 'test-secret-key';
  });

  it('signs every externally consumed URL with the public host', async () => {
    const { presignGet, presignGetKey, presignPut } = await import('../src/s3.js');
    const put = await presignPut('_incoming/test', 'image/jpeg', Buffer.alloc(32).toString('base64'));
    const urls = [put.url, await presignGet('people/test/page-01.jpg'), await presignGetKey('derived/test/ai-01.webp')];

    for (const url of urls) {
      expect(new URL(url).origin).toBe('https://s3.medireco.eckstein.pro');
    }
  });
});
