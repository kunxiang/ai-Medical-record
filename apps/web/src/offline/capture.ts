import { uuidv7 } from 'uuidv7';
import { MAX_UPLOAD_BYTES } from '@amr/contracts';
import {
  blobsOf, deleteCaptureCompletely, getBlob, getCapture, putBlob, putCapture,
  withDb, type BlobRecord, type CaptureRecord,
} from './db.js';

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

/** 旋转 Blob 指定角度(90, -90, 180, 270) */
export async function rotateBlob(
  blob: Blob,
  degrees: 90 | -90 | 180 | 270,
): Promise<{ blob: Blob; width: number; height: number }> {
  const normDeg = ((degrees % 360) + 360) % 360;
  if (normDeg === 0) {
    const size = await imageSize(blob);
    return { blob, width: size.width, height: size.height };
  }

  const imgUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('无法加载图片以进行旋转'));
      el.src = imgUrl;
    });

    const srcW = img.naturalWidth;
    const srcH = img.naturalHeight;
    const isSwap = normDeg === 90 || normDeg === 270;
    const destW = isSwap ? srcH : srcW;
    const destH = isSwap ? srcW : srcH;

    const canvas = document.createElement('canvas');
    canvas.width = destW;
    canvas.height = destH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布进行旋转');

    ctx.translate(destW / 2, destH / 2);
    ctx.rotate((normDeg * Math.PI) / 180);
    ctx.drawImage(img, -srcW / 2, -srcH / 2);

    const mime = blob.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const newBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('旋转图片失败'))), mime, 0.95);
    });

    return { blob: newBlob, width: destW, height: destH };
  } finally {
    URL.revokeObjectURL(imgUrl);
  }
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

/** 入队前的全部准备:校验 → 物化 Blob → 摘要 → 尺寸 → EXIF(原件零改动)。任何拒绝都在这里发生。 */
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
      exif = null;
    }
  }

  return {
    blob,
    byte_size: blob.size,
    sha256: sha,
    mime_type: mime,
    width: size.width,
    height: size.height,
    filename: file.name || 'capture',
    exif,
  };
}

/** 每页读入后立即落盘(审核 #002 A-16:只在内存 = iOS 相机返回时标签页被回收即全丢) */
export async function appendDraftPage(args: {
  draftId?: string;
  person: { id: string; slug: string; display_name: string } | null;
  page: PreparedPage;
  source: 'camera' | 'album' | 'pdf';
}): Promise<CaptureRecord> {
  const id = args.draftId ?? uuidv7();
  const existing = await getCapture(id);
  const pageNo = (existing?.page_count ?? 0) + 1;

  const blobRec: BlobRecord = {
    client_document_id: id,
    page_no: pageNo,
    blob: args.page.blob,
    byte_size: args.page.byte_size,
    sha256: args.page.sha256,
    mime_type: args.page.mime_type,
    width: args.page.width,
    height: args.page.height,
    capture_order: pageNo,                      // ADR-047:key 中的 NN 恒为拍摄序
    filename: args.page.filename,
    exif: args.page.exif,
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
        attempt: 0,
        next_attempt_at: 0,
        last_error: null,
        batch: null,
        discard_event_id: null,
        created_at: new Date().toISOString(),
        context: null,
      };
  await putCapture(rec);
  return rec;
}

/** 旋转草稿或本地待上传中的指定页(默认顺时针 90 度) */
export async function rotateDraftPage(
  clientDocumentId: string,
  pageNo: number,
  degrees: 90 | -90 = 90,
): Promise<{ blob: Blob; width: number; height: number; sha256: string }> {
  const blobRec = await getBlob(clientDocumentId, pageNo);
  if (!blobRec) throw new Error('未找到该页本地文件');
  if (blobRec.mime_type === 'application/pdf') throw new Error('PDF 格式暂不支持旋转');

  const rotated = await rotateBlob(blobRec.blob, degrees);
  const sha = await sha256Hex(rotated.blob);

  const updatedBlobRec: BlobRecord = {
    ...blobRec,
    blob: rotated.blob,
    byte_size: rotated.blob.size,
    sha256: sha,
    width: rotated.width,
    height: rotated.height,
  };
  await putBlob(updatedBlobRec);

  const captureRec = await getCapture(clientDocumentId);
  if (captureRec) {
    await putCapture({
      ...captureRec,
      batch: null, // 清空已有批次，使重试/上传时重新申请带最新 sha256 的 presign
      next_attempt_at: 0,
    });
  }

  return { blob: rotated.blob, width: rotated.width, height: rotated.height, sha256: sha };
}

/** 删除草稿中的单页并重新排列页码序号 */
export async function deleteDraftPage(
  clientDocumentId: string,
  pageNo: number,
): Promise<CaptureRecord | undefined> {
  const rec = await getCapture(clientDocumentId);
  if (!rec || rec.state !== 'draft') throw new Error('只能删除草稿中的页面');

  const blobs = await blobsOf(clientDocumentId, rec.page_count);
  const remaining = blobs.filter((b) => b.page_no !== pageNo);

  if (remaining.length === 0) {
    await deleteCaptureCompletely(clientDocumentId, rec.page_count);
    return undefined;
  }

  await withDb(async (connection) => {
    const tx = connection.transaction(['blobs', 'captures'], 'readwrite');
    const blobStore = tx.objectStore('blobs');
    for (let p = 1; p <= rec.page_count; p++) {
      await blobStore.delete([clientDocumentId, p]);
    }
    for (let i = 0; i < remaining.length; i++) {
      const pageNum = i + 1;
      const b = remaining[i]!;
      await blobStore.put({
        ...b,
        page_no: pageNum,
        capture_order: pageNum,
      });
    }
    const updatedRec: CaptureRecord = {
      ...rec,
      page_count: remaining.length,
      batch: null,
      next_attempt_at: 0,
    };
    await tx.objectStore('captures').put(updatedRec);
    await tx.done;
  });

  return await getCapture(clientDocumentId);
}

/** "完成"动作:draft → pending(有归属人)或 pending_person(无) */
export async function finalizeDraft(id: string): Promise<CaptureRecord | undefined> {
  const rec = await getCapture(id);
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
  const rec = await getCapture(id);
  if (!rec) return;
  if (!['draft', 'pending_person', 'pending', 'failed_terminal'].includes(rec.state)) {
    throw new Error('该项已开始上传,归属人不可更改(key 已由 person 决定)');
  }
  await putCapture({
    ...rec,
    person_id: person.id,
    person_slug: person.slug,
    person_display_name: person.display_name,
    state: rec.state === 'pending_person' ? 'pending' : rec.state,
    batch: null,          // 归属人变了,旧批次作废
    next_attempt_at: 0,
  });
}
