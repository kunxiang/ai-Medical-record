import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const EMAIL = process.env.SEED_EMAIL ?? 'owner@local.test';
const PASSWORD = process.env.SEED_PASSWORD ?? 'core-acceptance-password';
const BUNDLED_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CHROME_PATH = process.env.CHROME_PATH
  ?? (existsSync(BUNDLED_CHROME) ? BUNDLED_CHROME : '/usr/bin/google-chrome');
const REPO_ROOT = process.env.REPO_ROOT ?? resolve(process.cwd(), '..');
const PHOTO_FIXTURE = resolve(REPO_ROOT, 'fixtures/m1/photo-plain.png');

interface ContextSnapshot {
  version: number;
  stores: string[];
  template_count: number;
  sessions: Array<{
    id: string;
    scope_type: 'document' | 'standalone';
    stage: 'onsite' | 'same_day' | 'anytime';
    sync_state: string;
    client_document_id: string | null;
    document_bound: boolean;
  }>;
  answers: Array<{ session_id: string; question_key: string; state: string }>;
  media: Array<{ id: string; session_id: string; question_key: string; state: string; blob: { size: number; type: string } }>;
}

async function contextSnapshot(page: Page): Promise<ContextSnapshot> {
  return page.evaluate(async () => {
    const hooks = (globalThis as unknown as { __amr: { contextSnapshot: () => Promise<unknown> } }).__amr;
    return hooks.contextSnapshot();
  }) as Promise<ContextSnapshot>;
}

let passed = 0;
const failures: string[] = [];
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function login(page: Page, email = EMAIL, password = PASSWORD): Promise<void> {
  await page.goto(WEB, { waitUntil: 'networkidle' });
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await page.getByTestId('browse').waitFor({ timeout: 20_000 });
}

async function desktopChecks(context: BrowserContext): Promise<string[]> {
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('net::ERR_INTERNET_DISCONNECTED')) {
      browserErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await login(page);

  check('P0-W1 桌面固定四项主导航',
    await page.locator('nav[aria-label="主要导航"] button').count() === 4);
  check('P0-W2 采集是全局 FAB 而非平级导航',
    await page.getByTestId('capture-fab').isVisible()
      && await page.getByTestId('tab-capture').count() === 0);
  await page.getByTestId('capture-fab').click();
  await page.getByTestId('capture-workspace').waitFor();
  check('P0-W3 FAB 打开核心采集且归人提示可见',
    await page.getByText('归人仍是采集时唯一必须确认的信息。').isVisible());
  await page.getByRole('button', { name: '关闭采集' }).click();

  check('P0-W4 档案筛选工作台可见', await page.getByTestId('archive-filters').isVisible());
  const pdfCard = page.locator('button[data-testid^="doc-"]').filter({
    has: page.locator('[data-testid^="placeholder-"]'),
  }).first();
  await pdfCard.click();
  let dialog = page.getByRole('dialog');
  await dialog.getByText('人工元数据').waitFor();
  check('P0-W5 PDF 使用浏览器原件 fallback',
    await dialog.locator('iframe').count() === 1
      && await dialog.getByRole('button', { name: '新标签打开' }).isVisible()
      && await dialog.getByRole('button', { name: '下载原件' }).isVisible());
  await dialog.getByRole('button', { name: '关闭' }).click();

  const imageCard = page.locator('button[data-testid^="doc-"]').filter({ has: page.locator('img') }).first();
  await imageCard.click();
  dialog = page.getByRole('dialog');
  await dialog.getByText('人工元数据').waitFor();
  const detailImage = dialog.locator('img').first();
  await detailImage.waitFor();
  check('P0-W6 图片详情加载真实原件', await detailImage.evaluate((image) => (
    image as unknown as { naturalWidth: number }
  ).naturalWidth > 0));
  check('P0-W7 详情包含人工编辑与就诊归组',
    await dialog.getByRole('button', { name: '保存人工信息' }).isVisible()
      && await dialog.getByRole('button', { name: '保存归组' }).isVisible());
  check('P2-W1 文档详情原件旁提供 Observation 工作台入口',
    await dialog.getByTestId('observation-panel').isVisible()
      && await dialog.getByRole('button', { name: '从原件录入' }).isVisible());
  check('P1-W0 文档详情提供情境补录入口',
    await dialog.getByRole('button', { name: '补录情境' }).isVisible());
  const note = dialog.getByLabel('备注');
  await note.fill('真实浏览器人工修改验收');
  await dialog.getByRole('button', { name: '保存人工信息' }).click();
  await dialog.getByText('revision 5').waitFor({ timeout: 20_000 });
  check('P0-W7b 人工元数据修改真实持久化',
    await note.inputValue() === '真实浏览器人工修改验收');
  await dialog.getByRole('button', { name: '专注查看大图' }).click();
  const viewerImage = page.getByTestId('viewer-image');
  await viewerImage.waitFor();
  check('P0-W8 大图查看器完成图片解码',
    await viewerImage.evaluate((image) => (
      image as unknown as { naturalWidth: number }
    ).naturalWidth > 0));
  await page.getByTestId('viewer-close').click();

  const search = page.getByLabel('搜索档案');
  await search.fill('血脂');
  await search.press('Enter');
  const searchPanel = page.getByTestId('search-results');
  await searchPanel.getByText('Core 人工血脂记录').waitFor({ timeout: 20_000 });
  const searchText = await searchPanel.innerText();
  check('P0-W9 人工关键词检索命中且声明 core corpus',
    searchText.includes('Core 人工血脂记录')
      && searchText.includes('仅检索人工信息和已确认事实，不混入未确认建议。'),
    searchText.slice(0, 500));

  await page.getByTestId('tab-data').click();
  const dataView = page.getByTestId('data-view');
  await dataView.getByText('复查血脂').waitFor({ timeout: 20_000 });
  const dataText = await dataView.innerText();
  check('P0-W10 数据页展示手工就诊',
    dataText.includes('复查血脂') && await dataView.getByRole('button', { name: '新增就诊' }).isVisible(),
    dataText.slice(0, 500));
  await dataView.getByRole('button', { name: '编辑', exact: true }).first().click();
  const encounterDialog = page.getByRole('dialog');
  const advice = encounterDialog.getByLabel('医嘱原文');
  await advice.fill('浏览器人工更新医嘱');
  await encounterDialog.getByRole('button', { name: '保存就诊' }).click();
  await encounterDialog.waitFor({ state: 'hidden', timeout: 20_000 });
  await dataView.getByText('浏览器人工更新医嘱').waitFor({ timeout: 20_000 });
  check('P0-W10b 就诊修改真实持久化', true);

  const clinicalFacts = dataView.getByTestId('clinical-facts-panel');
  await clinicalFacts.getByText('阿莫西林胶囊').waitFor({ timeout: 20_000 });
  check('P4-W1 数据页读取处方/执行用药与人工事件',
    await clinicalFacts.getByText('0.9% 氯化钠注射液').isVisible()
      && await clinicalFacts.getByText('当日发热').isVisible()
      && await clinicalFacts.getByTestId('undated-events').isVisible());

  await clinicalFacts.getByTestId('add-medication').click();
  const medicationDialog = page.getByTestId('medication-dialog');
  await medicationDialog.getByTestId('medication-name').fill('浏览器记录氯雷他定片');
  await medicationDialog.getByTestId('medication-dose-raw').fill('10 mg');
  await medicationDialog.getByTestId('medication-started-on').fill('2026-08-28');
  await medicationDialog.getByTestId('save-medication').click();
  await medicationDialog.waitFor({ state: 'hidden', timeout: 20_000 });
  await clinicalFacts.getByText('浏览器记录氯雷他定片').waitFor({ timeout: 20_000 });
  check('P4-W2 Web 真实提交处方用药事实', true);

  await clinicalFacts.getByTestId('add-timeline-event').click();
  const timelineDialog = page.getByTestId('timeline-dialog');
  await timelineDialog.getByTestId('timeline-kind').selectOption('symptom');
  await timelineDialog.getByTestId('timeline-title').fill('既往过敏反应日期待核');
  await timelineDialog.getByTestId('timeline-precision').selectOption('unknown');
  await timelineDialog.getByTestId('save-timeline-event').click();
  await timelineDialog.waitFor({ state: 'hidden', timeout: 20_000 });
  const undated = clinicalFacts.getByTestId('undated-events');
  await undated.getByText('既往过敏反应日期待核').waitFor({ timeout: 20_000 });
  check('P4-W3 无日期事件进入独立分区且不伪造创建日期',
    (await undated.innerText()).includes('不使用创建时间冒充'));

  const observationPanel = dataView.getByTestId('observation-panel');
  await observationPanel.getByText('肌酐').first().waitFor({ timeout: 20_000 });
  check('P2-W2 数据页读取人工事实与确定性派生',
    await observationPanel.getByText('CREATININE', { exact: true }).first().isVisible()
      && await observationPanel.getByText('确定性派生', { exact: true }).isVisible());
  await observationPanel.getByTestId('open-observation-workbench').click();
  let observationWorkbench = page.getByTestId('observation-workbench');
  await observationWorkbench.waitFor();
  await observationWorkbench.getByLabel('第 1 行指标').fill('体重');
  await observationWorkbench.getByLabel('第 1 行结果').fill('71');
  await observationWorkbench.getByTestId('save-observations').click();
  await observationWorkbench.waitFor({ state: 'hidden', timeout: 20_000 });
  await observationPanel.getByText('WEIGHT', { exact: true }).first().waitFor({ timeout: 20_000 });
  check('P2-W3 Web 工作台真实提交已映射 Observation', true);

  await observationPanel.getByTestId('open-observation-workbench').click();
  observationWorkbench = page.getByTestId('observation-workbench');
  await observationWorkbench.getByRole('button', { name: '粘贴 TSV/CSV' }).click();
  await observationWorkbench.locator('textarea').fill(
    '项目\t结果\t单位\t参考范围\t标记\n离线草稿甲\t<3.2\t本院U\t1.0-4.0\tN\n离线草稿乙\t阴性\t\t阴性\t',
  );
  await observationWorkbench.getByRole('button', { name: '导入表格' }).click();
  await observationWorkbench.getByTestId('observation-row-1').waitFor();
  await page.waitForTimeout(500);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('browse').waitFor({ timeout: 20_000 });
  await page.getByTestId('tab-data').click();
  await page.getByTestId('observation-panel').getByTestId('open-observation-workbench').click();
  observationWorkbench = page.getByTestId('observation-workbench');
  await observationWorkbench.getByLabel('第 1 行指标').waitFor();
  check('P2-W4 TSV 草稿刷新后从 IndexedDB 恢复',
    await observationWorkbench.getByLabel('第 1 行指标').inputValue() === '离线草稿甲'
      && await observationWorkbench.getByLabel('第 1 行结果').inputValue() === '<3.2'
      && await observationWorkbench.getByLabel('第 2 行指标').inputValue() === '离线草稿乙');
  page.once('dialog', (prompt) => void prompt.accept());
  await observationWorkbench.getByRole('button', { name: '删除本机草稿' }).click();
  await observationWorkbench.waitFor({ state: 'hidden' });

  await page.getByTestId('tab-trends').click();
  const trendsView = page.getByTestId('trends-view');
  const metricGroupList = trendsView.getByTestId('metric-group-list');
  await metricGroupList.waitFor({ timeout: 20_000 });
  check('P0-W11/P3-W1 趋势明确只消费核心事实并读取用户监控组',
    await trendsView.getByText('仅核心事实').isVisible()
      && await metricGroupList.getByText('代谢趋势', { exact: true }).isVisible()
      && await metricGroupList.getByText('肌酐', { exact: true }).isVisible()
      && (await trendsView.innerText()).includes('未确认的智能建议不会进入图表'));

  await metricGroupList.getByText('代谢趋势', { exact: true }).click();
  await trendsView.getByText('9 个确认点').waitFor({ timeout: 20_000 });
  const trendText = await trendsView.getByTestId('trend-result').innerText();
  check('P3-W2 series/单位分线、报告参考、RCV 与情境事实可见',
    await trendsView.getByTestId('trend-chart').count() >= 2
      && await trendsView.getByTestId('trend-line').count() === 3
      && trendText.includes('单位未验证，不连线')
      && trendText.includes('rcv@1')
      && trendText.includes('同期情境事实')
      && trendText.includes('仅按时间叠加用户已记录事实，不解释因果。'),
    trendText.slice(0, 1200));

  await metricGroupList.getByText('肌酐', { exact: true }).click();
  await trendsView.getByText('尚不能形成趋势').waitFor({ timeout: 20_000 });
  check('P3-W3 单点状态诚实显示且保留逐点来源',
    (await trendsView.getByTestId('trend-total').innerText()).includes('1 个确认点')
      && await trendsView.getByRole('button', { name: /打开来源/ }).isVisible());
  await trendsView.getByRole('button', { name: /打开来源/ }).click();
  const sourceDialog = page.getByRole('dialog');
  await sourceDialog.getByTestId('source-bbox-highlight').waitFor({ timeout: 20_000 });
  check('P3-W4 来源回链打开正确文档页并按 bbox 高亮',
    await sourceDialog.getByText('第 1 / 1 页').isVisible()
      && await sourceDialog.getByTestId('source-bbox-highlight').isVisible());
  await sourceDialog.getByRole('button', { name: '关闭' }).click();

  await page.getByTestId('tab-trends').click();
  const exportPanel = trendsView.getByTestId('export-panel');
  await exportPanel.waitFor({ timeout: 20_000 });
  await exportPanel.getByText('所有者', { exact: true }).waitFor({ timeout: 20_000 });
  const initialExportText = await exportPanel.innerText();
  check('P4-W5 owner 在趋势页看到导出构建器和内部历史',
    await exportPanel.getByTestId('export-builder').isVisible()
      && await exportPanel.getByTestId('export-history-item').count() >= 3
      && await exportPanel.getByTestId('export-share-open').first().isVisible()
      && initialExportText.includes('生成后数据有更新')
      && await exportPanel.getByRole('button', { name: '按当前数据生成新版' }).first().isVisible());

  await exportPanel.getByRole('button', { name: '预览范围与缺口' }).click();
  const previewResult = exportPanel.getByTestId('export-preview-result');
  await previewResult.waitFor({ timeout: 20_000 });
  const previewText = await previewResult.innerText();
  check('P4-W6 生成前预览显示范围、数量、缺口与非医学结论边界',
    previewText.includes('生成前预览')
      && previewText.includes('指标序列')
      && previewText.includes('时间轴事件')
      && previewText.includes('数据缺口')
      && previewText.includes('不会生成诊断、治疗或用药建议'),
    previewText.slice(0, 1_200));

  await exportPanel.getByRole('button', { name: '确认预览后生成' }).click();
  const newestExport = exportPanel.getByTestId('export-history-item').first();
  await newestExport.getByText('已完成', { exact: true }).waitFor({ timeout: 40_000 });
  const newestExportText = await newestExport.innerText();
  const newestExportFormat = newestExportText.includes('PNG') ? 'png' : 'pdf';
  check('P4-W7 Web 从生成进度进入完成态且保留确定性版本信息',
    newestExportText.includes('renderer 1.0.0')
      && await newestExport.getByTestId('export-download').isVisible());

  const downloadPromise = page.waitForEvent('download', { timeout: 20_000 });
  await newestExport.getByTestId('export-download').click();
  const summaryDownload = await downloadPromise;
  check('P4-W8 完成摘要可通过 UI 下载',
    summaryDownload.suggestedFilename().endsWith(`.${newestExportFormat}`)
      && await summaryDownload.failure() === null,
    summaryDownload.suggestedFilename());

  await newestExport.getByTestId('export-share-open').click();
  const shareDialog = page.getByTestId('export-share-dialog');
  await shareDialog.waitFor({ timeout: 20_000 });
  const shareDialogText = await shareDialog.innerText();
  check('P4-W9 owner 分享前明确核对人员、范围、内容、到期和公开风险',
    shareDialogText.includes('Core 验收成员')
      && shareDialogText.includes('数据范围')
      && shareDialogText.includes('摘要内容')
      && shareDialogText.includes('有效期')
      && shareDialogText.includes('公开链接风险'));
  await shareDialog.getByTestId('export-share-confirm').check();
  await shareDialog.getByTestId('export-share-create').click();
  const publicLink = shareDialog.getByLabel('公开分享链接');
  await publicLink.waitFor({ timeout: 20_000 });
  const publicUrl = await publicLink.inputValue();
  const publicResponse = await context.request.get(publicUrl);
  const publicContentType = publicResponse.headers()['content-type'] ?? '';
  check('P4-W10 新 token 只在创建后展示且公开文件 no-store 可访问',
    /^[^?#]+\/api\/v1\/shared\/exports\/[A-Za-z0-9_-]{43}$/.test(publicUrl)
      && publicResponse.status() === 200
      && publicResponse.headers()['cache-control']?.includes('no-store') === true
      && (publicContentType.includes('application/pdf') || publicContentType.includes('image/png')),
    `url=${publicUrl} status=${publicResponse.status()} content-type=${publicContentType}`);
  page.once('dialog', (prompt) => void prompt.accept());
  await shareDialog.getByRole('button', { name: '撤销' }).first().click();
  await shareDialog.getByText('已撤销', { exact: true }).first().waitFor({ timeout: 20_000 });
  const revokedResponse = await context.request.get(publicUrl);
  check('P4-W11 owner 从 UI 撤销后同一公开链接统一不可用', revokedResponse.status() === 404);
  await page.getByRole('dialog').getByRole('button', { name: '关闭' }).click();

  // P1 浏览器主链全部在离线模式执行，证明模板/草稿/媒体不依赖 API 或 AI。
  let initialContext = await contextSnapshot(page);
  for (let attempt = 0; initialContext.template_count === 0 && attempt < 50; attempt += 1) {
    await page.waitForTimeout(100);
    initialContext = await contextSnapshot(page);
  }
  const requiredStores = [
    'context_templates', 'context_sessions', 'context_answers', 'context_media', 'observation_drafts',
  ];
  check('P1-W1/P2-10 IndexedDB v3 与 Context/Observation 草稿 store 已就绪',
    initialContext.version === 3
      && requiredStores.every((store) => initialContext.stores.includes(store))
      && initialContext.template_count > 0,
    JSON.stringify(initialContext));

  await context.setOffline(true);
  await page.getByTestId('tab-data').click();
  await page.getByTestId('context-new-anytime').click();
  await page.getByTestId('context-template-picker').waitFor();
  check('P1-W2 离线可创建 standalone anytime 且只展示适用模板',
    await page.getByTestId('context-template-generic').isVisible()
      && await page.getByTestId('context-template-lab-report').count() === 0);
  await page.getByTestId('context-template-generic').click();
  await page.getByLabel('这件事大约发生在哪天？').fill('2026-08-28');
  const anytimeNote = page.getByLabel('记录当时的情况');
  await anytimeNote.fill('离线随时记录验收');
  await anytimeNote.blur();
  let snapshot = await contextSnapshot(page);
  const standalone = snapshot.sessions.find((session) => session.scope_type === 'standalone');
  check('P1-W3 standalone 的日期/文字回答立即保存在本机',
    standalone !== undefined
      && snapshot.answers.filter((answer) => answer.session_id === standalone.id).length === 2,
    JSON.stringify(snapshot));
  await page.getByRole('button', { name: '关闭' }).last().click();

  await page.getByTestId('capture-fab').click();
  await page.getByTestId('input-album').setInputFiles(PHOTO_FIXTURE);
  await page.getByTestId('btn-finish').waitFor();
  await page.getByTestId('btn-finish').click();
  await page.getByTestId('context-template-picker').waitFor();
  snapshot = await contextSnapshot(page);
  const onsite = snapshot.sessions.find((session) => session.scope_type === 'document' && session.stage === 'onsite');
  check('P1-W4 文档未上传时已建立可恢复的 Context 占位',
    onsite !== undefined && onsite.client_document_id !== null && !onsite.document_bound,
    JSON.stringify(snapshot));
  await page.getByTestId('context-template-lab-report').click();
  await page.getByRole('button', { name: '空腹（≥8小时）' }).click();
  const fallback = page.getByLabel('今天为什么来医院？文字回答');
  await fallback.fill('离线文字替代录音');
  await fallback.blur();
  check('P1-W5 录音题始终提供可保存的文字替代',
    await page.getByText('录音不可用时，文字入口始终保留。').first().isVisible());
  await page.getByRole('button', { name: '完成记录' }).click();
  await page.getByText('已保存在本机，联网后会自动同步。').waitFor();
  await page.getByRole('button', { name: '关闭' }).last().click();

  await page.getByRole('button', { name: '关闭采集' }).click();
  await page.getByTestId('tab-data').click();
  await page.getByRole('button', { name: /当天补录/ }).first().click();
  const photoInput = page.getByTestId('context-dialog').locator('input[type="file"]');
  await photoInput.setInputFiles(PHOTO_FIXTURE);
  await page.getByAltText('情境照片预览').waitFor();
  snapshot = await contextSnapshot(page);
  const sameDay = snapshot.sessions.find((session) => session.stage === 'same_day');
  const localPhoto = sameDay
    ? snapshot.media.find((item) => item.session_id === sameDay.id && item.question_key === 'medication_photo')
    : undefined;
  check('P1-W6 照片原件以 Blob 和待上传状态保存在本机',
    sameDay !== undefined && localPhoto !== undefined
      && localPhoto.state === 'pending' && localPhoto.blob.size > 0 && localPhoto.blob.type === 'image/png',
    JSON.stringify(snapshot));
  if (sameDay) {
    const recovered = await page.evaluate(async (sessionId) => {
      const hooks = (globalThis as unknown as { __amr: { forceContextRecovery: (id: string) => Promise<number> } }).__amr;
      return hooks.forceContextRecovery(sessionId);
    }, sameDay.id);
    snapshot = await contextSnapshot(page);
    const recoveredSession = snapshot.sessions.find((session) => session.id === sameDay.id);
    const recoveredPhoto = snapshot.media.find((item) => item.session_id === sameDay.id);
    check('P1-W7 session syncing 与媒体 pending_finalize 重启后回退为可重试状态',
      recovered >= 2 && recoveredSession?.sync_state === 'pending' && recoveredPhoto?.state === 'pending',
      JSON.stringify(snapshot));
  }
  await page.getByRole('button', { name: '关闭' }).last().click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('browse').waitFor({ timeout: 20_000 });
  await page.getByTestId('tab-data').click();
  await page.getByRole('button', { name: /当天补录/ }).first().click();
  snapshot = await contextSnapshot(page);
  check('P1-W8 离线刷新后 Context 草稿和媒体预览仍可恢复',
    await page.getByAltText('情境照片预览').isVisible()
      && snapshot.answers.some((answer) => answer.question_key === 'visit_reason'));

  await page.close();
  return browserErrors;
}

async function mobileChecks(context: BrowserContext): Promise<string[]> {
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('net::ERR_INTERNET_DISCONNECTED')) {
      browserErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await login(page);
  const mobileNav = page.locator('nav[aria-label="移动端主要导航"]');
  check('P0-W12 手机底栏固定四项',
    await mobileNav.isVisible() && await mobileNav.locator('button').count() === 4);
  check('P0-W13 手机采集 FAB 可见且不遮挡底栏', await page.getByTestId('capture-fab').isVisible());
  await page.getByTestId('mobile-tab-data').click();
  check('P0-W14 手机底栏可进入数据页', await page.getByTestId('data-view').isVisible());
  const mobileFacts = page.getByTestId('clinical-facts-panel');
  await mobileFacts.getByText('浏览器记录氯雷他定片').waitFor({ timeout: 20_000 });
  check('P4-W4 手机数据页可读取用药和日期未记录事件',
    await mobileFacts.getByText('浏览器记录氯雷他定片').isVisible()
      && await mobileFacts.getByTestId('undated-events').getByText('既往过敏反应日期待核').isVisible());
  await page.getByTestId('mobile-tab-trends').click();
  const mobileTrends = page.getByTestId('trends-view');
  const mobileMetricGroups = mobileTrends.getByTestId('metric-group-list');
  await mobileMetricGroups.waitFor({ timeout: 20_000 });
  check('P3-W5 手机端可选择监控组并看到趋势核心边界',
    await mobileTrends.getByText('仅核心事实').isVisible()
      && await mobileMetricGroups.getByText('代谢趋势', { exact: true }).isVisible());
  const mobileExport = mobileTrends.getByTestId('export-panel');
  await mobileExport.waitFor({ timeout: 20_000 });
  check('P4-W12 手机端导出入口位于趋势内且不新增主导航',
    await mobileExport.getByText('就诊摘要导出').isVisible()
      && await mobileExport.getByRole('button', { name: '预览范围与缺口' }).isVisible()
      && await mobileNav.locator('button').count() === 4);
  await page.close();
  return browserErrors;
}

async function viewerChecks(context: BrowserContext): Promise<string[]> {
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await login(page, 'core-outsider@local.test', 'core-outsider-password');
  await page.getByTestId('tab-data').click();
  await page.getByRole('button', { name: 'Core 验收成员', exact: true }).click();
  await page.getByTestId('tab-trends').click();
  const panel = page.getByTestId('export-panel');
  await panel.getByText('只读成员', { exact: true }).waitFor({ timeout: 20_000 });
  check('P4-W13 viewer 只发现/下载完成历史，不能生成或公开分享',
    await panel.getByText('只读权限').isVisible()
      && await panel.getByTestId('export-builder').count() === 0
      && await panel.getByTestId('export-history-item').count() >= 1
      && await panel.getByTestId('export-download').first().isVisible()
      && await panel.getByTestId('export-share-open').count() === 0);
  await page.close();
  return browserErrors;
}

const browser = await chromium.launch(existsSync(CHROME_PATH) ? { executablePath: CHROME_PATH } : {});
try {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const desktopErrors = await desktopChecks(desktop);
  await desktop.close();
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const mobileErrors = await mobileChecks(mobile);
  await mobile.close();
  const viewer = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const viewerErrors = await viewerChecks(viewer);
  await viewer.close();
  const errors = [...desktopErrors, ...mobileErrors, ...viewerErrors];
  check('P0-W15 浏览器控制台无未处理错误', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

console.log(`Core Web acceptance: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
