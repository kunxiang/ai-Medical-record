// spec m1-99 §0.1:测试注入面。仅 VITE_M1_TEST_HOOKS=1 构建暴露;
// 生产构建里本模块的调用点被 tree-shake(CI 断言产物不含 __amr)。
import { allCaptures, db } from './offline/db.js';
import { appendDraftPage, finalizeDraft, preparePage } from './offline/capture.js';
import { tick } from './offline/queue.js';
import { setPause, type PauseSpec } from './offline/pause.js';

export function installTestHooks(deps: {
  currentPerson: () => { id: string; slug: string; display_name: string } | null;
  notifyChanged: () => void;   // 注入面直接写 IDB,需通知 React 刷新队列视图
}): void {
  const fixtureBase = import.meta.env.VITE_FIXTURE_BASE ?? '/fixtures';
  // 离线用例需要在断网前把 fixture 读进内存(否则 enqueueFixture 的 fetch 必失败)
  const cache = new Map<string, ArrayBuffer>();

  async function fixtureBytes(name: string): Promise<ArrayBuffer> {
    const hit = cache.get(name);
    if (hit) return hit;
    const res = await fetch(`${fixtureBase}/${name}`);
    if (!res.ok) throw new Error(`fixture 不存在: ${name}`);
    const buf = await res.arrayBuffer();
    cache.set(name, buf);
    return buf;
  }

  (window as unknown as Record<string, unknown>)['__amr'] = {
    async preloadFixtures(names: string[]) {
      for (const n of names) await fixtureBytes(n);
      return names.length;
    },
    async enqueueFixture(name: string, opts?: { count?: number; personId?: string | null; asOneDocument?: boolean }) {
      const count = opts?.count ?? 1;
      const person = opts?.personId === null ? null : deps.currentPerson();
      const ids: string[] = [];
      let draftId: string | undefined;
      for (let i = 0; i < count; i++) {
        const bytes = await fixtureBytes(name);
        const mime = name.endsWith('.png') ? 'image/png' : name.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg';
        const file = new File([bytes], name, { type: mime });
        const page = await preparePage(file);
        const rec = await appendDraftPage({
          draftId: opts?.asOneDocument ? draftId : undefined,
          person, page,
          source: mime === 'application/pdf' ? 'pdf' : 'camera',
        });
        draftId = rec.client_document_id;
        if (!opts?.asOneDocument) {
          await finalizeDraft(rec.client_document_id);
          ids.push(rec.client_document_id);
        }
      }
      if (opts?.asOneDocument && draftId) {
        await finalizeDraft(draftId);
        ids.push(draftId);
      }
      deps.notifyChanged();
      return ids;
    },
    async queueSnapshot() {
      return (await allCaptures()).map((r) => ({
        client_document_id: r.client_document_id, state: r.state, attempt: r.attempt,
        person_id: r.person_id, page_count: r.page_count, captured_at: r.captured_at,
        last_error: r.last_error,
      }));
    },
    async blobDigest(id: string, pageNo: number) {
      const b = await (await db()).get('blobs', [id, pageNo]);
      return b ? { sha256: b.sha256, byte_size: b.byte_size, actual_size: b.blob.size } : null;
    },
    pauseAt(stage: PauseSpec['stage'], nth: number) {
      setPause({ stage, nth });
    },
    resume() {
      setPause(null);
    },
    async runQueue() {
      await tick('test');
      deps.notifyChanged();
    },
    async clearAll() {
      const d = await db();
      await Promise.all([d.clear('captures'), d.clear('blobs'), d.clear('people_cache'), d.clear('kv')]);
      deps.notifyChanged();
    },
  };
}
