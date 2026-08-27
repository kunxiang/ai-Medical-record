import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, Camera, CircleUserRound, ShieldCheck, TriangleAlert } from 'lucide-react';
import { api, auth, type CreatePersonInput } from './api/client.js';
import {
  allCachedPeople, allCaptures, clearAllLocalData, kvGet, kvSet, putCachedPerson,
  recoverAfterRestart, replaceCachedPeople,
  type CaptureRecord, type PersonCacheRecord,
} from './offline/db.js';
import { configureQueue, pauseQueue, resumeQueue, startQueueDriver } from './offline/queue.js';
import { lastPersistStatus, requestPersistence } from './offline/persist.js';
import { LoginView } from './features/capture/LoginView.js';
import { CaptureView } from './features/capture/CaptureView.js';
import { BrowseView } from './features/browse/BrowseView.js';
import { AccountView } from './features/account/AccountView.js';
import { BrandMark } from './ui/BrandMark.js';
import { Alert } from './ui/Alert.js';
import { cn } from './ui/cn.js';

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

      const cached = await allCachedPeople();
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
          id: p.id,
          slug: p.slug,
          display_name: p.display_name,
          relation_to_owner: p.relation_to_owner,
        })); // ★ 只缓存四项:选择器不需要过敏史/生日(医疗 PII)
        await replaceCachedPeople(slim);
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
    await putCachedPerson(slim);
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
    setNotice(
      queue.length > 0
        ? '已安全退出。当前设备上的待上传内容仍被保留，重新登录后会继续上传。'
        : '已安全退出账户。',
    );
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
        setNotice(
          '账户已注销，但浏览器未能自动清除全部本机缓存。请在浏览器的网站数据设置中删除 MediReco 数据。',
        );
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
    <div className="min-h-screen flex flex-col bg-background text-ink font-sans selection:bg-brand-100 selection:text-brand-900">
      {/* Topbar Header */}
      <header className="sticky top-0 z-40 w-full bg-white/85 backdrop-blur-md border-b border-line/80 shadow-2xs">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          <BrandMark compact />

          {/* Current Person Badge (Desktop/Tablet) */}
          <div
            className="hidden sm:flex items-center gap-2.5 px-3 py-1.5 rounded-2xl bg-surface-subtle border border-line/70"
            aria-label="当前档案"
          >
            <span className="w-6 h-6 rounded-lg bg-brand-50 text-brand-700 font-bold text-xs flex items-center justify-center">
              {selected?.display_name.slice(0, 1) ?? '—'}
            </span>
            <div className="flex flex-col text-left leading-tight">
              <span className="text-[10px] text-muted font-medium">当前档案</span>
              <strong className="text-xs text-ink font-bold">{selected?.display_name ?? '尚未选择'}</strong>
            </div>
          </div>

          {/* Navigation Controls */}
          <nav
            className="flex items-center p-1 rounded-2xl bg-surface-subtle border border-line/70"
            aria-label="主要导航"
          >
            <button
              type="button"
              onClick={() => setTab('capture')}
              data-testid="tab-capture"
              className={cn(
                'relative flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-150 cursor-pointer',
                tab === 'capture'
                  ? 'bg-brand-500 text-white shadow-xs'
                  : 'text-muted hover:text-ink',
              )}
            >
              <Camera size={16} aria-hidden="true" />
              <span>采集</span>
              {pendingCount > 0 && (
                <span
                  className={cn(
                    'inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold leading-none',
                    tab === 'capture' ? 'bg-white text-brand-700' : 'bg-brand-500 text-white',
                  )}
                >
                  {pendingCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setTab('browse')}
              data-testid="tab-browse"
              className={cn(
                'flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-150 cursor-pointer',
                tab === 'browse'
                  ? 'bg-brand-500 text-white shadow-xs'
                  : 'text-muted hover:text-ink',
              )}
            >
              <Archive size={16} aria-hidden="true" />
              <span>档案</span>
            </button>

            <button
              type="button"
              onClick={() => setTab('account')}
              data-testid="tab-account"
              className={cn(
                'flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-150 cursor-pointer',
                tab === 'account'
                  ? 'bg-brand-500 text-white shadow-xs'
                  : 'text-muted hover:text-ink',
              )}
            >
              <CircleUserRound size={16} aria-hidden="true" />
              <span>账户</span>
            </button>
          </nav>

          {/* Privacy badge */}
          <div className="hidden md:flex items-center gap-1.5 text-xs text-brand-700 font-medium bg-brand-50/80 px-2.5 py-1 rounded-full border border-brand-200/60">
            <ShieldCheck size={15} className="text-brand-600" aria-hidden="true" />
            <span>安全归档</span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 w-full max-w-4xl mx-auto px-4 py-6 md:px-6 md:py-8 space-y-6">
        {notice && (
          <Alert variant="warning" data-testid="notice">
            <span>{notice}</span>
          </Alert>
        )}

        {!persisted && (
          <Alert variant="warning" data-testid="persist-warning">
            <span>
              浏览器可能在长期不使用后清理本地数据。iOS 请把本站「添加到主屏幕」以获得持久存储,并尽快联网上传。
            </span>
          </Alert>
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
          <BrowseView
            person={selected}
            people={people}
            onSelect={onSelect}
            queue={queue}
          />
        ) : (
          <AccountView
            queuedItemCount={queue.length}
            onLogout={logout}
            onDeleteAccount={deleteAccount}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="w-full py-6 px-4 border-t border-line/60 text-center text-xs text-muted/80 bg-white/40">
        <div className="flex items-center justify-center gap-2">
          <ShieldCheck size={15} className="text-brand-600" />
          <span>原始文件零改动保存 · 全程加密传输</span>
        </div>
      </footer>
    </div>
  );
}
