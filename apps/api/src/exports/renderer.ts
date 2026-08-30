import { createHash } from 'node:crypto';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import sharp from 'sharp';
import { canonicalJsonString, type ExportInputManifestT } from '@amr/contracts';
import { VISIT_SUMMARY_FONT_BYTES } from './font.js';

const A4 = { width: 595.28, height: 841.89 };
const PNG = { width: 1240, height: 1754 };
const FIXED_PDF_DATE = new Date('2000-01-01T00:00:00.000Z');

interface SummaryLine {
  text: string;
  size: number;
  color: 'ink' | 'muted' | 'brand' | 'warning';
  gapBefore?: number;
}
type OriginalLoader = (key: string) => Promise<Buffer | null>;

const FIRST_PAGE_METRIC_LIMIT = 3;
const FIRST_PAGE_EVENT_LIMIT = 3;
const FIRST_PAGE_GAP_LIMIT = 2;

function compactText(value: string, maxCharacters: number): string {
  const characters = [...value];
  return characters.length <= maxCharacters
    ? value : `${characters.slice(0, maxCharacters - 1).join('')}…`;
}

function rangeLabel(manifest: ExportInputManifestT): string {
  const { from, to } = manifest.selection;
  if (from && to) return `${from} 至 ${to}`;
  if (from) return `${from} 起`;
  if (to) return `截至 ${to}`;
  return '全部已确认记录';
}

function timeLabel(value: ExportInputManifestT['events'][number]): string {
  if (value.occurred_on === null) return '日期未记录';
  if (value.occurred_at) return value.occurred_at.slice(0, 16).replace('T', ' ');
  return `${value.occurred_on}（仅日期）`;
}

export function visitSummaryLines(manifest: ExportInputManifestT): SummaryLine[] {
  const lines: SummaryLine[] = [
    { text: 'MediReco 就诊摘要', size: 22, color: 'brand' },
    { text: `${manifest.person.display_name}　出生：${manifest.person.birth_date}　范围：${rangeLabel(manifest)}`, size: 10, color: 'ink', gapBefore: 6 },
    { text: '本摘要只汇总人工确认事实与确定性计算，不包含诊断、治疗建议或 AI 医学结论。', size: 9, color: 'warning', gapBefore: 5 },
    { text: `数据快照：${manifest.source_revision_hash.slice(0, 12)}　指标 ${manifest.counts.metric_series} 项　事件 ${manifest.events.length} 条`, size: 8, color: 'muted', gapBefore: 4 },
    { text: '最新指标与变化', size: 15, color: 'ink', gapBefore: 14 },
  ];
  if (manifest.metrics.length === 0) {
    lines.push({ text: '范围内没有已确认指标。', size: 10, color: 'muted', gapBefore: 5 });
  }
  for (const metric of manifest.metrics.slice(0, FIRST_PAGE_METRIC_LIMIT)) {
    lines.push({ text: compactText(`${metric.metric_group_name} · ${metric.series_label}`, 72), size: 11, color: 'brand', gapBefore: 7 });
    lines.push({
      text: compactText(`最新｜${metric.latest.value}　${metric.latest.observed_on}`
        + `${metric.latest.reference ? `　本报告参考：${metric.latest.reference}` : ''}`, 92),
      size: 10, color: 'brand', gapBefore: 2,
    });
    lines.push({
      text: compactText(`变化｜${metric.change ?? '仅有一个可用记录，暂不能比较变化'}`, 92),
      size: 9, color: 'ink', gapBefore: 2,
    });
    lines.push({
      text: compactText(`来源｜${metric.latest.source_label}`
        + `${metric.latest.source_available ? '' : ' · 原件不可用'}`, 92),
      size: 8, color: 'muted', gapBefore: 1,
    });
  }
  if (manifest.metrics.length > FIRST_PAGE_METRIC_LIMIT) lines.push({
    text: `另有 ${manifest.metrics.length - FIRST_PAGE_METRIC_LIMIT} 项指标未在一页纸首屏展开，请返回数据页查看全部。`,
    size: 8, color: 'muted', gapBefore: 4,
  });
  lines.push({ text: '关键事件时间轴', size: 15, color: 'ink', gapBefore: 14 });
  const dated = manifest.events.filter((event) => event.occurred_on !== null);
  const undated = manifest.events.filter((event) => event.occurred_on === null);
  if (dated.length === 0) lines.push({ text: '范围内没有有日期的事件。', size: 10, color: 'muted', gapBefore: 5 });
  const firstPageEvents = dated.slice(0, FIRST_PAGE_EVENT_LIMIT);
  if (firstPageEvents.length < FIRST_PAGE_EVENT_LIMIT && undated.length > 0) {
    firstPageEvents.push(...undated.slice(0, FIRST_PAGE_EVENT_LIMIT - firstPageEvents.length));
  }
  for (const event of firstPageEvents) {
    lines.push({ text: compactText(`${timeLabel(event)}　${event.label}`, 96), size: 9, color: 'ink', gapBefore: 4 });
    lines.push({
      text: compactText(`来源｜${event.source_label}${event.source_available ? '' : ' · 原件不可用'}`, 72),
      size: 8, color: 'muted', gapBefore: 1,
    });
  }
  if (manifest.events.length > firstPageEvents.length) lines.push({
    text: `另有 ${manifest.events.length - firstPageEvents.length} 条事件未在一页纸首屏展开（其中日期未记录 ${undated.length} 条）。`,
    size: 8, color: undated.length > 0 ? 'warning' : 'muted', gapBefore: 5,
  });
  if (manifest.gaps.length > 0) {
    lines.push({ text: '数据缺口', size: 12, color: 'warning', gapBefore: 12 });
    for (const gap of manifest.gaps.slice(0, FIRST_PAGE_GAP_LIMIT)) lines.push({
      text: compactText(`• ${gap.message}`, 88), size: 8, color: 'muted', gapBefore: 2,
    });
    if (manifest.gaps.length > FIRST_PAGE_GAP_LIMIT) lines.push({
      text: `另有 ${manifest.gaps.length - FIRST_PAGE_GAP_LIMIT} 项缺口，请在生成前预览中核对。`,
      size: 8, color: 'muted', gapBefore: 2,
    });
  }
  return lines;
}

function wrapPdf(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const output: string[] = [];
  let current = '';
  for (const char of [...text]) {
    const candidate = current + char;
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      output.push(current);
      current = char;
    } else current = candidate;
  }
  if (current) output.push(current);
  return output.length > 0 ? output : [''];
}

const PDF_COLORS = {
  ink: rgb(0.08, 0.12, 0.18), muted: rgb(0.35, 0.4, 0.46),
  brand: rgb(0.02, 0.43, 0.45), warning: rgb(0.65, 0.34, 0.02),
};

function drawHeader(page: PDFPage, font: PDFFont, continuation: boolean): number {
  if (!continuation) return A4.height - 42;
  page.drawText('MediReco 就诊摘要（续）', { x: 36, y: A4.height - 34, font, size: 9, color: PDF_COLORS.muted });
  return A4.height - 52;
}

async function appendOriginals(
  pdf: PDFDocument, manifest: ExportInputManifestT, loadOriginal: OriginalLoader,
): Promise<void> {
  if (!manifest.selection.include_originals) return;
  for (const original of manifest.originals) {
    if (!original.available) continue;
    const bytes = await loadOriginal(original.storage_key);
    if (!bytes) throw new Error(`original_missing:${original.page_id}`);
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== original.content_sha256) throw new Error(`original_sha256_mismatch:${original.page_id}`);
    if (original.mime_type === 'application/pdf') {
      const source = await PDFDocument.load(bytes, { updateMetadata: false });
      const pages = await pdf.copyPages(source, source.getPageIndices());
      for (const page of pages) pdf.addPage(page);
      continue;
    }
    const image = original.mime_type === 'image/png'
      ? await pdf.embedPng(bytes)
      : original.mime_type === 'image/jpeg'
        ? await pdf.embedJpg(bytes)
        : await pdf.embedPng(await sharp(bytes).png({ compressionLevel: 9 }).toBuffer());
    const page = pdf.addPage([A4.width, A4.height]);
    const scale = Math.min((A4.width - 36) / image.width, (A4.height - 36) / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    page.drawImage(image, { x: (A4.width - width) / 2, y: (A4.height - height) / 2, width, height });
  }
}

async function renderPdf(manifest: ExportInputManifestT, loadOriginal: OriginalLoader): Promise<Buffer> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit);
  pdf.setTitle('MediReco 就诊摘要');
  pdf.setAuthor('MediReco deterministic core');
  pdf.setCreator('medireco-visit-summary@1.0.0');
  pdf.setProducer('pdf-lib@1.17.1');
  pdf.setCreationDate(FIXED_PDF_DATE);
  pdf.setModificationDate(FIXED_PDF_DATE);
  const font = await pdf.embedFont(VISIT_SUMMARY_FONT_BYTES, { subset: true });
  let page = pdf.addPage([A4.width, A4.height]);
  let y = drawHeader(page, font, false);
  let pageIndex = 0;
  for (const line of visitSummaryLines(manifest)) {
    y -= line.gapBefore ?? 0;
    const wrapped = wrapPdf(font, line.text, line.size, A4.width - 72);
    const lineHeight = line.size * 1.45;
    if (y - lineHeight * wrapped.length < 35) {
      page = pdf.addPage([A4.width, A4.height]);
      pageIndex += 1;
      y = drawHeader(page, font, true);
    }
    for (const text of wrapped) {
      page.drawText(text, { x: 36, y, font, size: line.size, color: PDF_COLORS[line.color] });
      y -= lineHeight;
    }
  }
  for (const current of pdf.getPages().slice(0, pageIndex + 1)) {
    current.drawText('仅供整理个人医疗记录使用 · 请以来源原件和医生判断为准', {
      x: 36, y: 18, font, size: 7, color: PDF_COLORS.muted,
    });
  }
  await appendOriginals(pdf, manifest, loadOriginal);
  return Buffer.from(await pdf.save({ useObjectStreams: false, addDefaultPage: false }));
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function wrapCharacters(text: string, count = 48): string[] {
  const chars = [...text];
  const lines: string[] = [];
  for (let index = 0; index < chars.length; index += count) lines.push(chars.slice(index, index + count).join(''));
  return lines.length > 0 ? lines : [''];
}

async function renderSummaryPng(manifest: ExportInputManifestT): Promise<Buffer> {
  const fontData = VISIT_SUMMARY_FONT_BYTES.toString('base64');
  let y = 88;
  const nodes: string[] = [];
  for (const line of visitSummaryLines(manifest)) {
    y += (line.gapBefore ?? 0) * 2;
    const size = Math.round(line.size * 2.05);
    for (const part of wrapCharacters(line.text, Math.max(18, Math.floor(1050 / size)))) {
      if (y + Math.round(size * 1.5) > PNG.height - 80) {
        throw new Error('png_summary_overflow');
      }
      nodes.push(`<text x="76" y="${y}" class="${line.color}" font-size="${size}">${escapeXml(part)}</text>`);
      y += Math.round(size * 1.5);
    }
  }
  const svg = Buffer.from(`<svg width="${PNG.width}" height="${PNG.height}" xmlns="http://www.w3.org/2000/svg">
    <style>@font-face{font-family:NotoFixed;src:url(data:font/woff;base64,${fontData}) format('woff')}text{font-family:NotoFixed}.ink{fill:#14202e}.muted{fill:#66717d}.brand{fill:#067277}.warning{fill:#a85406}</style>
    <rect width="100%" height="100%" fill="#fff"/><rect width="18" height="100%" fill="#0b8a8f"/>
    ${nodes.join('')}<text x="76" y="1710" class="muted" font-size="16">仅供整理个人医疗记录使用 · 请以来源原件和医生判断为准</text>
  </svg>`);
  return sharp(svg).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

async function renderPng(manifest: ExportInputManifestT, loadOriginal: OriginalLoader): Promise<Buffer> {
  const pages: Buffer[] = [await renderSummaryPng(manifest)];
  if (manifest.selection.include_originals) {
    for (const original of manifest.originals) {
      if (!original.available) continue;
      if (original.mime_type === 'application/pdf') throw new Error(`png_pdf_original_unsupported:${original.page_id}`);
      const bytes = await loadOriginal(original.storage_key);
      if (!bytes) throw new Error(`original_missing:${original.page_id}`);
      const sha = createHash('sha256').update(bytes).digest('hex');
      if (sha !== original.content_sha256) throw new Error(`original_sha256_mismatch:${original.page_id}`);
      pages.push(await sharp(bytes).resize({ width: PNG.width, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer());
    }
  }
  if (pages.length === 1) return pages[0]!;
  const meta = await Promise.all(pages.map((item) => sharp(item).metadata()));
  const height = meta.reduce((sum, item) => sum + (item.height ?? 0), 0);
  let top = 0;
  const composites = pages.map((input, index) => {
    const item = { input, top, left: 0 };
    top += meta[index]!.height ?? 0;
    return item;
  });
  return sharp({ create: { width: PNG.width, height, channels: 3, background: '#ffffff' } })
    .composite(composites).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

export async function renderVisitSummary(
  manifest: ExportInputManifestT,
  loadOriginal: OriginalLoader = async () => null,
): Promise<{
  bytes: Buffer; sha256: string; contentHash: string; contentType: string; extension: 'pdf' | 'png';
}> {
  const contentHash = createHash('sha256').update(canonicalJsonString(manifest)).digest('hex');
  const bytes = manifest.selection.format === 'pdf'
    ? await renderPdf(manifest, loadOriginal) : await renderPng(manifest, loadOriginal);
  return {
    bytes, sha256: createHash('sha256').update(bytes).digest('hex'), contentHash,
    contentType: manifest.selection.format === 'pdf' ? 'application/pdf' : 'image/png',
    extension: manifest.selection.format,
  };
}
