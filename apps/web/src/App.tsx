import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, Camera, CircleUserRound, ShieldCheck, TriangleAlert } from 'lucide-react';
import { api, auth, type CreatePersonInput } from './api/client.js';
import {
  allCaptures, clearAllLocalData, db, kvGet, kvSet, recoverAfterRestart,
  type CaptureRecord, type PersonCacheRecord,
} from './offline/db.js';
import { configureQueue, pauseQueue, resumeQueue, startQueueDriver } from './offline/queue.js';
import { lastPersistStatus, requestPersistence } from './offline/persist.js';
import { LoginView } from './features/capture/LoginView.js';
import { CaptureView } from './features/capture/CaptureView.js';
import { BrowseView } from './features/browse/BrowseView.js';
import { AccountView } from './features/account/AccountView.js';
import { BrandMark } from './ui/BrandMark.js';

export type Person = PersonCacheRecord;

export function App(): JSX.Element {
  const [token, setToken] = useState<string | null>(auth.get());
  const [people, setPeople] = useState<Person[]>([]);
  const [selected, setSelected] = useState<Person | null>(null);
  const [queue, setQueue] = useState<CaptureRecord[]>([]);
  const [persisted, setPersisted] = useState(true);
  const [tab, setTab] = useState<'capture' | 'browse' | 'account'>('capture');
  const [notice, setNotice] = useState<string | null>(null);
  const peopleMutationRevision = useRef(0);

  const refreshQueue = useCallback(async () => {
    setQueue(await allCaptures());
  }, []);

  // 启动:崩溃恢复 → 持久化申请 → 人员缓存 → 队列驱动
  useEffect(() => {
    void (async () => {
      const recovered = await recoverAfterRestart();
      if (recovered > 0) console.info(`[amr] 崩溃恢复:${recovered} 项回退为 pending`);
      const status = await requestPersistence();
      setPersisted(status.persisted || (await lastPersistStatus()));

      const cached = await (await db()).getAll('people_cache');
      setPeople(cached);
      const lastId = await kvGet<string>('last_selected_person_id');
      setSelected(cached.find((p) => p.id === lastId) ?? cached[0] ?? null);

      await refreshQueue();
      configureQueue({
        onChange: () => void refreshQueue(),
        onAuthLost: () => {
          setToken(null);
          setNotice('登录已失效,请重新登录。队列已暂停,不会丢失。');
        },
        onPersonUnavailable: () => setNotice('该档案不可访问,相关队列项已暂停。'),
      });
      return startQueueDriver();
    })();
  }, [refreshQueue]);

  // 登录后强制拉取人员缓存(登录必然在线 ⇒ 把"缓存缺失"压到近乎不可达,m1-04 §5)
  useEffect(() => {
    if (!token) return;
    void (async () => {
      try {
        const revision = peopleMutationRevision.current;
        const res = await api.people();
        // 创建成员可能与登录后的初次刷新并发。较早发出的 GET 不得用旧列表覆盖新成员。
        if (revision !== peopleMutationRevision.current) return;
        const slim: Person[] = res.people.map((p) => ({
          id: p.id, slug: p.slug, display_name: p.display_name, relation_to_owner: p.relation_to_owner,
        }));   // ★ 只缓存四项:选择器不需要过敏史/生日(医疗 PII)
        const d = await db();
        const tx = d.transaction('people_cache', 'readwrite');
        await tx.store.clear();
        for (const p of slim) await tx.store.put(p);
        await tx.done;
        await kvSet('people_fetched_at', new Date().toISOString());
        setPeople(slim);
        setSelected((cur) => cur ?? slim[0] ?? null);
      } catch {
        /* 离线:用缓存渲染 */
      }
    })();
  }, [token]);

  useEffect(() => {
    // 动态 import:条件为编译期常量 false 时,Rollup 连同模块一起摇掉
    // ⇒ 生产产物不含 __amr 注入面(m1-99 B6)
    if (import.meta.env.VITE_M1_TEST_HOOKS === '1') {
      void import('./test-hooks.js').then((m) =>
        m.installTestHooks({ currentPerson: () => selected, notifyChanged: () => void refreshQueue() }),
      );
    }
  }, [selected, refreshQueue]);

  const onSelect = useCallback((p: Person) => {
    setSelected(p);
    void kvSet('last_selected_person_id', p.id);
  }, []);

  const createPerson = useCallback(async (input: CreatePersonInput): Promise<Person> => {
    const created = await api.createPerson(input);
    peopleMutationRevision.current += 1;
    const slim: Person = {
      id: created.id,
      slug: created.slug,
      display_name: created.display_name,
      relation_to_owner: created.relation_to_owner,
    };
    await (await db()).put('people_cache', slim);
    await kvSet('last_selected_person_id', slim.id);
    setPeople((current) => [...current.filter((person) => person.id !== slim.id), slim]);
    setSelected(slim);
    return slim;
  }, []);

  const pendingCount = queue.filter((item) => item.state !== 'draft').length;

  const logout = useCallback(() => {
    pauseQueue();
    auth.clear();
    setToken(null);
    setNotice(queue.length > 0
      ? '已安全退出。当前设备上的待上传内容仍被保留，重新登录后会继续上传。'
      : '已安全退出账户。');
  }, [queue.length]);

  const deleteAccount = useCallback(async (password: string) => {
    pauseQueue();
    let deleted = false;
    try {
      await api.deleteAccount(password);
      deleted = true;
      try {
        await clearAllLocalData();
        setNotice('账户已注销，登录身份和本机缓存均已清除。');
      } catch {
        // 服务端注销已经不可逆，不能把本地清理失败伪装成“注销失败”并继续使用旧会话。
        setNotice('账户已注销，但浏览器未能自动清除全部本机缓存。请在浏览器的网站数据设置中删除 MediReco 数据。');
      }
      setPeople([]);
      setSelected(null);
      setQueue([]);
    } catch (error) {
      if (!deleted) resumeQueue();
      throw error;
    } finally {
      if (deleted) {
        auth.clear();
        setToken(null);
      }
    }
  }, []);

  if (!token) {
    return (
      <LoginView
        notice={notice}
        onLoggedIn={(t) => {
          auth.set(t);
          setToken(t);
          setNotice(null);
          // 必须 resumeQueue 而非 tick:401 时队列被 pauseQueue() 置停,
          // 只 tick 会被 paused 拦掉 —— 重新登录后队列将永不恢复(m1-99 A16)
          resumeQueue();
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <BrandMark compact />
          <div className="topbar-person" aria-label="当前档案">
            <span className="person-avatar small">{selected?.display_name.slice(0, 1) ?? '—'}</span>
            <span>
              <small>当前档案</small>
              <strong>{selected?.display_name ?? '尚未选择'}</strong>
            </span>
          </div>
          <nav aria-label="主要导航">
            <button className={tab === 'capture' ? 'on' : ''} onClick={() => setTab('capture')} data-testid="tab-capture">
              <Camera size={19} aria-hidden="true" />
              <span>采集</span>
              {pendingCount > 0 && <span className="nav-badge">{pendingCount}</span>}
            </button>
            <button className={tab === 'browse' ? 'on' : ''} onClick={() => setTab('browse')} data-testid="tab-browse">
              <Archive size={19} aria-hidden="true" />
              <span>档案</span>
            </button>
            <button className={tab === 'account' ? 'on' : ''} onClick={() => setTab('account')} data-testid="tab-account">
              <CircleUserRound size={19} aria-hidden="true" />
              <span>账户</span>
            </button>
          </nav>
          <div className="privacy-status">
            <ShieldCheck size={17} aria-hidden="true" />
            <span>安全归档</span>
          </div>
        </div>
      </header>

      <main className="app-content">
      {notice && <div className="banner warn" data-testid="notice"><TriangleAlert size={19} /> <span>{notice}</span></div>}
      {!persisted && (
        <div className="banner warn" data-testid="persist-warning">
          <TriangleAlert size={19} />
          <span>浏览器可能在长期不使用后清理本地数据。iOS 请把本站「添加到主屏幕」以获得持久存储,并尽快联网上传。</span>
        </div>
      )}

      {tab === 'capture' ? (
        <CaptureView
          people={people}
          selected={selected}
          onSelect={onSelect}
          onCreatePerson={createPerson}
          queue={queue}
          onQueueChanged={refreshQueue}
        />
      ) : tab === 'browse' ? (
        <BrowseView person={selected} people={people} onSelect={onSelect} queue={queue} />
      ) : (
        <AccountView queuedItemCount={queue.length} onLogout={logout} onDeleteAccount={deleteAccount} />
      )}
      </main>
      <footer className="app-footer">
        <ShieldCheck size={15} /> 原始文件零改动保存 · 全程加密传输
      </footer>
    </div>
  );
}
