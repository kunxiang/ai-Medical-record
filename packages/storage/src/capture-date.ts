// spec m0-03 §3:capture_date = captured_at 折算到上传者 account 的 IANA 时区后取日期。
// 已知权衡(记录在案):多账号异时区时同一 person 的文档可能落不同日期目录;key 永不变。

export function captureDateInZone(capturedAt: string, timeZone: string): string {
  const t = new Date(capturedAt);
  if (Number.isNaN(t.getTime())) throw new Error(`非法 captured_at: ${capturedAt}`);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(t); // en-CA → YYYY-MM-DD
}

/** journal/manifest 月份分片:事件时间戳的 UTC 年月(spec m0-03 §4 / 审核 #001 B3) */
export function utcYearMonth(iso: string): { year: string; month: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`非法时间戳: ${iso}`);
  return {
    year: String(d.getUTCFullYear()).padStart(4, '0'),
    month: String(d.getUTCMonth() + 1).padStart(2, '0'),
  };
}

/** 服务端生成时间戳的规范形态:YYYY-MM-DDTHH:mm:ss.SSSZ(审核 #001 B8) */
export function serverTimestamp(d: Date = new Date()): string {
  return d.toISOString();
}
