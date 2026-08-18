import { kvGet, kvSet } from './db.js';

// spec m1-04 §7:WebKit 对 script-writable 存储有"7 天无交互即清除"策略
// (已加入主屏幕的 Web App 豁免),且 Safari 不实现 persist()。
// 这是"一张不丢"最现实的失效路径 —— 必须申请持久化并在未获授权时如实告知。

export interface StorageStatus {
  persisted: boolean;
  canEstimate: boolean;
  quotaBytes: number | null;
  usageBytes: number | null;
}

export async function requestPersistence(): Promise<StorageStatus> {
  let persisted = false;
  try {
    if (navigator.storage?.persisted) persisted = await navigator.storage.persisted();
    if (!persisted && navigator.storage?.persist) persisted = await navigator.storage.persist();
  } catch {
    persisted = false;
  }
  await kvSet('persist_granted', persisted);

  let quotaBytes: number | null = null;
  let usageBytes: number | null = null;
  const canEstimate = typeof navigator.storage?.estimate === 'function';
  if (canEstimate) {
    try {
      const est = await navigator.storage.estimate();
      quotaBytes = est.quota ?? null;
      usageBytes = est.usage ?? null;
    } catch {
      /* 忽略 */
    }
  }
  return { persisted, canEstimate, quotaBytes, usageBytes };
}

export async function lastPersistStatus(): Promise<boolean> {
  return (await kvGet<boolean>('persist_granted')) ?? false;
}

/** 入队前配额门禁:剩余 < 3× 待写字节则拒绝。
 *  estimate() 不可用(旧 iOS)→ fail-open 并记警告,不阻断拍照(m1-04 §7.3)。 */
export async function ensureRoomFor(bytes: number): Promise<{ ok: boolean; reason?: string }> {
  if (typeof navigator.storage?.estimate !== 'function') {
    console.warn('[amr] StorageManager.estimate 不可用,跳过配额门禁(fail-open)');
    return { ok: true };
  }
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (typeof quota !== 'number' || typeof usage !== 'number') return { ok: true };
    const free = quota - usage;
    if (free < bytes * 3) {
      return {
        ok: false,
        reason: `本地存储空间不足(剩余约 ${(free / 1048576).toFixed(0)} MB)。请先联网上传已有队列。`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: true };
  }
}
