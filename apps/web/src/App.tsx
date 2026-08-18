import { useCallback, useEffect, useState } from 'react';
import { api, auth } from './api/client.js';
import { allCaptures, db, kvGet, kvSet, recoverAfterRestart, type CaptureRecord, type PersonCacheRecord } from './offline/db.js';
import { configureQueue, resumeQueue, startQueueDriver } from './offline/queue.js';
import { lastPersistStatus, requestPersistence } from './offline/persist.js';
import { LoginView } from './features/capture/LoginView.js';
import { CaptureView } from './features/capture/CaptureView.js';
import { BrowseView } from './features/browse/BrowseView.js';

export type Person = PersonCacheRecord;

export function App(): JSX.Element {
  const [token, setToken] = useState<string | null>(auth.get());
  const [people, setPeople] = useState<Person[]>([]);
  const [selected, setSelected] = useState<Person | null>(null);
  const [queue, setQueue] = useState<CaptureRecord[]>([]);
  const [persisted, setPersisted] = useState(true);
  const [tab, setTab] = useState<'capture' | 'browse'>('capture');
  const [notice, setNotice] = useState<string | null>(null);

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
        const res = await api.people();
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
    <div className="app">
      <header className="topbar">
        <strong>AI 病历</strong>
        <nav>
          <button className={tab === 'capture' ? 'on' : ''} onClick={() => setTab('capture')} data-testid="tab-capture">采集</button>
          <button className={tab === 'browse' ? 'on' : ''} onClick={() => setTab('browse')} data-testid="tab-browse">档案</button>
        </nav>
      </header>

      {notice && <div className="banner warn" data-testid="notice">{notice}</div>}
      {!persisted && (
        <div className="banner warn" data-testid="persist-warning">
          浏览器可能在长期不使用后清理本地数据。iOS 请把本站「添加到主屏幕」以获得持久存储,并尽快联网上传。
        </div>
      )}

      {tab === 'capture' ? (
        <CaptureView
          people={people}
          selected={selected}
          onSelect={onSelect}
          queue={queue}
          onQueueChanged={refreshQueue}
        />
      ) : (
        <BrowseView person={selected} queue={queue} />
      )}
    </div>
  );
}
