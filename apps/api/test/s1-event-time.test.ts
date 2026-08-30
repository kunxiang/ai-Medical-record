import { describe, expect, it } from 'vitest';
import { Stage1Out, Stage1OutLenient } from '@amr/contracts';
import { instantFromReport, reportInstantIso } from '../src/jobs/report-time.js';

describe('单据时刻按档案时区还原', () => {
  it('无偏移的时分按目标时区解释,而不是按进程本地时区', () => {
    // 深圳化验单印的是 19:08,对应 UTC 11:08。若按容器本地(UTC)读会平移 8 小时。
    const at = instantFromReport('2026-08-21T19:08:00', 'Asia/Shanghai');
    expect(at?.toISOString()).toBe('2026-08-21T11:08:00.000Z');
  });

  it('已带偏移的值原样采信', () => {
    const at = instantFromReport('2026-08-21T19:08:00+02:00', 'Asia/Shanghai');
    expect(at?.toISOString()).toBe('2026-08-21T17:08:00.000Z');
  });

  it('跨零点也不串日期', () => {
    const at = instantFromReport('2026-08-21T00:30:00', 'Asia/Shanghai');
    expect(at?.toISOString()).toBe('2026-08-20T16:30:00.000Z');
  });

  it('夏令时区按当日实际偏移换算', () => {
    // 柏林 8 月为 CEST(+02:00)
    const at = instantFromReport('2026-08-21T12:00:00', 'Europe/Berlin');
    expect(at?.toISOString()).toBe('2026-08-21T10:00:00.000Z');
  });

  it('没有时刻就是没有', () => {
    expect(instantFromReport(null, 'Asia/Shanghai')).toBeNull();
  });
});

describe('S1 响应解析容错', () => {
  const base = {
    doc_type: 'lab_report', doc_type_confidence: 1,
    patient_name: '向坤', patient_sex: 'male', patient_age_text: '41岁',
    patient_identifiers: [], facility_name_raw: '某医院', department_raw: '全科',
    sampled_on: '2026-08-21', reported_on: '2026-08-21',
    event_at: '2026-08-21T19:08:00',
    summary: '血常规',
    pages: [{ page_no: 1, page_label: null, page_index: null, page_total: null, full_text: '白细胞 6.1' }],
    pii_spans: [], boundary_hint: null, unmodeled: [],
  };

  it('接受单据上不带时区的时刻', () => {
    const parsed = Stage1OutLenient.safeParse(base);
    expect(parsed.success).toBe(true);
  });

  it('时刻格式不合规时只丢该字段,不废弃整份识别', () => {
    const parsed = Stage1OutLenient.safeParse({ ...base, event_at: '2026年8月21日 19:08' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.event_at).toBeNull();
      expect(parsed.data.patient_name).toBe('向坤');
      expect(parsed.data.facility_name_raw).toBe('某医院');
    }
  });

  it('日期不合规同样只丢该字段', () => {
    const parsed = Stage1OutLenient.safeParse({ ...base, sampled_on: '2026-13-45' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.sampled_on).toBeNull();
  });
});

describe('线上契约保持严格', () => {
  it('发给模型的 schema 未被放宽 —— 否则请求指纹漂移,既有 cassette 基线全部失配', () => {
    const naive = { doc_type: 'lab_report', event_at: '2026-08-21T19:08:00' };
    expect(Stage1Out.safeParse(naive).success).toBe(false);
  });

  it('归一后即可通过严格契约', () => {
    expect(reportInstantIso('2026-08-21T19:08:00', 'Asia/Shanghai')).toBe('2026-08-21T11:08:00.000Z');
  });
});
