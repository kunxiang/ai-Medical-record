// spec m1-99 §0.2:确定性生成真实图像 fixture。
// M0 的 fakeJpeg() 是 libvips 不可解码的伪 JPEG,沿用它会让所有派生物用例误报。
// 产物落 fixtures/m1/(二进制不提交仓库,与 fixtures/README 的"不提交原始影像"一致)。
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/m1');
mkdirSync(OUT, { recursive: true });

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const manifest: Record<string, { file: string; sha256: string; bytes: number; mime: string }> = {};

function record(name: string, file: string, buf: Buffer, mime: string): void {
  writeFileSync(path.join(OUT, file), buf);
  manifest[name] = { file, sha256: sha(buf), bytes: buf.length, mime };
  console.log(`  ${file}  ${buf.length} bytes  ${sha(buf).slice(0, 12)}…`);
}

/** 确定性彩色图案(不用随机数,保证每次生成字节一致) */
function pattern(w: number, h: number, seed: number): Buffer {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      px[i] = (x * 7 + seed * 31) % 256;
      px[i + 1] = (y * 5 + seed * 17) % 256;
      px[i + 2] = ((x + y) * 3 + seed * 11) % 256;
    }
  }
  return px;
}

const raw = (w: number, h: number, seed: number) =>
  sharp(pattern(w, h, seed), { raw: { width: w, height: h, channels: 3 } });

// ① 含 GPS + Orientation=6 + DateTimeOriginal 的 JPEG —— A4b/A4c/B4 的核心样本
//    (源必须真的带 GPS,否则 "派生物无 GPS" 是空断言)
const withExif = await raw(1200, 800, 3)
  .withMetadata({ orientation: 6 })            // ★ 必须走这个 API:withExifMerge 写 IFD0.Orientation 不生效
  .withExifMerge({
    IFD2: {                                    // ExifIFD:DateTimeOriginal
      DateTimeOriginal: '2023:05:01 09:00:00',
    },
    IFD3: {                                    // GPS IFD
      GPSLatitudeRef: 'N', GPSLatitude: '22/1 32/1 0/1',
      GPSLongitudeRef: 'E', GPSLongitude: '114/1 3/1 0/1',
    },
  })
  .jpeg({ quality: 90, mozjpeg: false })
  .toBuffer();
record('photo-gps-o6', 'photo-gps-o6.jpg', withExif, 'image/jpeg');

// ② 无 EXIF 的 PNG
record('photo-plain', 'photo-plain.png', await raw(900, 600, 5).png({ compressionLevel: 6 }).toBuffer(), 'image/png');

// ③ 连拍三页(可区分)
for (const n of [1, 2, 3]) {
  record(`page-${n}`, `page-${n}.jpg`, await raw(800, 1200, 10 + n).jpeg({ quality: 85 }).toBuffer(), 'image/jpeg');
}

// ④ 单页 PDF
const pdf = await PDFDocument.create();
pdf.addPage([595, 842]).drawText('M1 fixture', { x: 60, y: 760, size: 24 });
pdf.setCreationDate(new Date(0));
pdf.setModificationDate(new Date(0));
record('doc-1page', 'doc-1page.pdf', Buffer.from(await pdf.save({ useObjectStreams: false })), 'application/pdf');

// ⑤ > 50 MiB 的合法 JPEG(入队前拒绝路径 A7)
const huge = await raw(9000, 7000, 7).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer();
record('huge', 'huge.jpg', huge, 'image/jpeg');
if (huge.length <= 50 * 1024 * 1024) {
  console.error(`  ⚠️ huge.jpg 仅 ${(huge.length / 1048576).toFixed(1)} MiB,未超 50 MiB —— A7 需要更大的样本`);
  process.exit(1);
}

writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`fixtures 已生成于 ${OUT}(manifest.json 含各文件已知 sha256)`);
