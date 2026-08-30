import { describe, expect, it } from 'vitest';
import { buildQueryString } from './client.js';

describe('P0 API query serialization', () => {
  it('保留 false 并省略空值，由严格 query boolean 契约正确解析', () => {
    const query = new URLSearchParams(buildQueryString({
      person_id: 'person', include_archived: false, cursor: undefined, q: '', limit: 20,
    }));
    expect(query.get('person_id')).toBe('person');
    expect(query.get('limit')).toBe('20');
    expect(query.get('include_archived')).toBe('false');
    expect(query.has('cursor')).toBe(false);
    expect(query.has('q')).toBe(false);
  });

  it('保留 true 和日期语义筛选', () => {
    const query = new URLSearchParams(buildQueryString({
      include_archived: true, date_field: 'reported', from: '2026-01-01',
    }));
    expect(query.get('include_archived')).toBe('true');
    expect(query.get('date_field')).toBe('reported');
    expect(query.get('from')).toBe('2026-01-01');
  });
});
