// 纯函数,不碰 DB/env —— 时区换算必须能被单测直接覆盖。
/** 单据上印的时分基本不带时区。直接 `new Date(naive)` 会按**进程本地时区**解释,
 *  容器里就是 UTC —— 深圳的化验单会凭空平移 8 小时。这里按档案所有者的时区还原成瞬时;
 *  已带偏移的值原样采信。 */
export function instantFromReport(value: string | null, timezone: string): Date | null {
  if (!value) return null;
  if (/(Z|[+-]\d{2}:\d{2})$/.test(value)) return new Date(value);
  const guess = new Date(`${value}Z`);
  if (Number.isNaN(guess.getTime())) return null;
  // 在目标时区把这个"假定为 UTC"的瞬时格式化回墙上时间,与原文的差值即该时区当时的偏移。
  const wall = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(guess).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  const shifted = Date.parse(
    `${wall.year}-${wall.month}-${wall.day}T${wall.hour === '24' ? '00' : wall.hour}:${wall.minute}:${wall.second}Z`,
  );
  if (Number.isNaN(shifted)) return null;
  return new Date(guess.getTime() * 2 - shifted);
}

/** 归一为带偏移的 ISO 字符串,供严格契约(Stage1Out / artifact)落库。 */
export function reportInstantIso(value: string | null, timezone: string): string | null {
  return instantFromReport(value, timezone)?.toISOString() ?? null;
}
