// R2 的部分能力(Bucket Locks)是 S3 API 的 Cloudflare 扩展,AWS SDK 没有对应 Command。
// 这里提供最小的 SigV4 原始请求能力,只用于这类扩展子资源。
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';

export interface SignedResult { status: number; body: string }

export async function r2Signed(
  method: string,
  query: Record<string, string>,
  body?: string,
  pathOverride?: string,
): Promise<SignedResult> {
  const endpoint = new URL(process.env.S3_ENDPOINT!);
  const bucket = process.env.S3_BUCKET!;
  const signer = new SignatureV4({
    service: 's3',
    region: process.env.S3_REGION ?? 'auto',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY!,
      secretAccessKey: process.env.S3_SECRET_KEY!,
    },
    sha256: Sha256,
    uriEscapePath: false,
  });

  const req = new HttpRequest({
    method,
    protocol: endpoint.protocol,
    hostname: endpoint.hostname,
    path: pathOverride ?? `/${bucket}`,
    query,
    headers: {
      host: endpoint.hostname,
      ...(body !== undefined ? { 'content-type': 'application/xml' } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });

  const signed = await signer.sign(req);
  const qs = Object.entries(query)
    .map(([k, v]) => (v === '' ? encodeURIComponent(k) : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`))
    .join('&');
  const res = await fetch(`${endpoint.origin}${signed.path}${qs ? `?${qs}` : ''}`, {
    method,
    headers: signed.headers as Record<string, string>,
    ...(body !== undefined ? { body } : {}),
  });
  return { status: res.status, body: (await res.text()).slice(0, 1200) };
}
