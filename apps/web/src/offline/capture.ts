import { uuidv7 } from 'uuidv7';
import { MAX_UPLOAD_BYTES } from '@amr/contracts';
import { db, putBlob, putCapture, type BlobRecord, type CaptureRecord } from './db.js';

// spec m1-05 §3。核心纪律:原件字节零改动 —— 不解码、不重编码、不旋转、不剥 EXIF。

export class CaptureRejected extends Error {}

const MIME_WHITELIST = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

export async function sha256Hex(blob: Blob): Promise<string> {
  // WebCrypto 无增量接口(审核 #002 A-6):整块摘要;单文件 ≤50 MiB 由入队前校验保证
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 原始像素尺寸(imageOrientation:'none' ⇒ 与服务端 page-NN.json 一致,m1-05 §3) */
async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'none' });
  const size = { width: bmp.width, height: bmp.height };
  bmp.close();
  return size;
}

/** PDF 首页 MediaBox 取整 pt(纯解析,不渲染;与 m0-03 §2 一致) */
async function pdfSize(blob: Blob): Promise<{ width: number; height: number }> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(await blob.arrayBuffer(), { updateMetadata: false });
  const page = doc.getPage(0);
  return { width: Math.max(1, Math.round(page.getWidth())), height: Math.max(1, Math.round(page.getHeight())) };
}

export interface PreparedPage {
  blob: Blob;
  byte_size: number;
  sha256: string;
  mime_type: string;
  width: number;
  height: number;
  filename: string;
  exif: { captured_at: string | null; orientation: number | null } | null;
}

/** 入队前的全部准备:校验 → 物化 Blob → 摘要 → 尺寸 → EXIF。任何拒绝都在这里发生。 */
export async function preparePage(file: File): Promise<PreparedPage> {
  const mime = file.type.toLowerCase().split(';')[0]!.trim();
  if (!MIME_WHITELIST.has(mime)) {
    throw new CaptureRejected(
      mime === 'image/heic' || mime === 'image/heif'
        ? 'iOS 的 HEIC 格式暂不支持:请在 设置 → 相机 → 格式 中选择「兼容性最佳」,或先转为 JPEG'
        : `不支持的文件类型:${mime || '未知'}`,
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new CaptureRejected(
      `单个文件不能超过 ${Math.floor(MAX_UPLOAD_BYTES / 1048576)} MB(当前 ${(file.size / 1048576).toFixed(1)} MB)`,
    );
  }

  // ★ 物化为 Blob:File 携带宿主文件引用,相机/相册的临时文件被系统回收后
  //   跨会话读取会抛 NotFoundError,而此时 UI 早已告诉用户"已存档"(审核 #002 A-9)
  const bytes = await file.arrayBuffer();
  const blob = new Blob([bytes], { type: mime });

  const [sha, size] = await Promise.all([
    sha256Hex(blob),
    mime === 'application/pdf' ? pdfSize(blob) : imageSize(blob),
  ]);

  let exif: PreparedPage['exif'] = null;
  if (mime !== 'application/pdf') {
    let exifr: (typeof import('exifr'))['default'];
    try {
      ({ default: exifr } = await import('exifr'));
    } catch {
      // 动态 chunk 未缓存时不能把「组件加载失败」降级成「图片没有 EXIF」:
      // 否则离线导入旧单据会永久使用今天作为 capture_date。
      throw new CaptureRejected('图片日期解析组件尚未就绪，请恢复网络后重试；本次文件尚未保存');
    }

    try {
      // 纯解析,不改动源字节
      // orientation 必须走专用入口:pick 模式下 IFD0 的 Orientation 取不到
      const [parsed, ori] = await Promise.all([
        exifr.parse(blob, { pick: ['DateTimeOriginal'] }) as Promise<Record<string, unknown> | undefined>,
        exifr.orientation(blob).catch(() => undefined) as Promise<number | undefined>,
      ]);
      const dto = parsed?.['DateTimeOriginal'] as Date | undefined;
      exif = {
        captured_at: dto instanceof Date && !Number.isNaN(dto.getTime()) ? dto.toISOString() : null,
        orientation: typeof ori === 'number' ? ori : null,
      };
    } catch {
      exif = null;   // EXIF 解析失败不阻断采集
    }
  }

  return {
    blob, byte_size: blob.size, sha256: sha, mime_type: mime,
    width: size.width, height: size.height, filename: file.name || 'capture', exif,
  };
}

/** 每页读入后立即落盘(审核 #002 A-16:只在内存 = iOS 相机返回时标签页被回收即全丢) */
export async function appendDraftPage(args: {
  draftId?: string;
  person: { id: string; slug: string; display_name: string } | null;
  page: PreparedPage;
  source: 'camera' | 'album' | 'pdf';
}): Promise<CaptureRecord> {
  const d = await db();
  const id = args.draftId ?? uuidv7();
  const existing = await d.get('captures', id);
  const pageNo = (existing?.page_count ?? 0) + 1;

  const blobRec: BlobRecord = {
    client_document_id: id, page_no: pageNo,
    blob: args.page.blob, byte_size: args.page.byte_size, sha256: args.page.sha256,
    mime_type: args.page.mime_type, width: args.page.width, height: args.page.height,
    capture_order: pageNo,                      // ADR-047:key 中的 NN 恒为拍摄序
    filename: args.page.filename, exif: args.page.exif,
  };
  await putBlob(blobRec);

  // captured_at:EXIF DateTimeOriginal 优先(否则相册导入的旧单据会永久落进今天的 key)
  const exifTime = existing?.captured_at_from_exif ? existing.captured_at : args.page.exif?.captured_at ?? null;
  const rec: CaptureRecord = existing
    ? { ...existing, page_count: pageNo }
    : {
        client_document_id: id,
        person_id: args.person?.id ?? null,
        person_slug: args.person?.slug ?? null,
        person_display_name: args.person?.display_name ?? null,
        source: args.source,
        captured_at: exifTime ?? new Date().toISOString(),
        captured_at_from_exif: exifTime !== null,
        page_count: pageNo,
        state: 'draft',
        attempt: 0, next_attempt_at: 0, last_error: null, batch: null,
        discard_event_id: null,
        created_at: new Date().toISOString(),
        context: null,
      };
  await putCapture(rec);
  return rec;
}

/** "完成"动作:draft → pending(有归属人)或 pending_person(无) */
export async function finalizeDraft(id: string): Promise<CaptureRecord | undefined> {
  const rec = await (await db()).get('captures', id);
  if (!rec || rec.state !== 'draft') return rec;
  const next: CaptureRecord = {
    ...rec,
    state: rec.person_id ? 'pending' : 'pending_person',
    next_attempt_at: 0,
  };
  await putCapture(next);
  return next;
}

/** 改归属人:draft/pending_person/pending/failed_terminal 且未成功 presign 时允许(m1-04 §5) */
export async function reassignQueued(
  id: string,
  person: { id: string; slug: string; display_name: string },
): Promise<void> {
  const rec = await (await db()).get('captures', id);
  if (!rec) return;
  if (!['draft', 'pending_person', 'pending', 'failed_terminal'].includes(rec.state)) {
    throw new Error('该项已开始上传,归属人不可更改(key 已由 person 决定)');
  }
  await putCapture({
    ...rec,
    person_id: person.id, person_slug: person.slug, person_display_name: person.display_name,
    state: rec.state === 'pending_person' ? 'pending' : rec.state,
    batch: null,          // 归属人变了,旧批次作废
    next_attempt_at: 0,
  });
}
