import { describe, expect, it } from 'vitest';
import {
  ExportPreviewRequest, ExportPreviewResponse, ExportShareCreateRequest,
  ExportShareCreateResponse, ExportListResponse, VisitSummaryCreateRequest,
} from '../src/exports.js';

const personId = '018f0000-0000-7000-8000-000000000901';

describe('P4 export contracts', () => {
  it('freezes defaults and validates the date range', () => {
    expect(ExportPreviewRequest.parse({ person_id: personId })).toEqual({
      person_id: personId, metric_group_ids: [], from: null, to: null,
      include_events: true, include_undated_events: true, include_originals: false, format: 'pdf',
    });
    expect(() => ExportPreviewRequest.parse({
      person_id: personId, from: '2026-09-01', to: '2026-08-01',
    })).toThrow();
  });

  it('requires a stable operation id for generation', () => {
    expect(() => VisitSummaryCreateRequest.parse({ person_id: personId })).toThrow();
    expect(VisitSummaryCreateRequest.parse({
      person_id: personId, client_operation_id: '018f0000-0000-7000-8000-000000000902',
    }).include_undated_events).toBe(true);
  });

  it('keeps preview counts, gaps and provenance strict', () => {
    const result = ExportPreviewResponse.safeParse({
      selection: ExportPreviewRequest.parse({ person_id: personId }),
      person: { id: personId, display_name: '测试', birth_date: '1990-01-01', sex_at_birth: 'unknown' },
      counts: {
        metric_groups: 0, metric_series: 0, observations: 0, encounters: 0,
        medications: 0, context_events: 0, timeline_events: 0, undated_events: 0,
        original_documents: 0, original_pages: 0,
      },
      metrics: [], events: [], gaps: [], originals: [], original_bytes_estimate: 0,
      estimated_pages: 1, source_revision_hash: 'a'.repeat(64), can_generate: false,
    });
    expect(result.success).toBe(true);
  });

  it('requires explicit, revision-bound confirmation and returns a token only in create response', () => {
    const request = ExportShareCreateRequest.parse({
      client_operation_id: '018f0000-0000-7000-8000-000000000903',
      expires_in_seconds: 300, source_revision_hash: 'a'.repeat(64), confirmed: true,
    });
    expect(request.expires_in_seconds).toBe(300);
    expect(() => ExportShareCreateRequest.parse({ ...request, expires_in_seconds: 299 })).toThrow();
    expect(() => ExportShareCreateRequest.parse({ ...request, confirmed: false })).toThrow();
    expect(() => ExportShareCreateResponse.parse({
      share: {
        id: personId, export_job_id: personId, expires_at: '2026-08-28T10:00:00.000Z',
        created_by: personId, created_at: '2026-08-28T09:00:00.000Z', revoked_at: null,
        last_accessed_at: null, access_count: 0,
      }, token: 'short', token_recoverable: false,
    })).toThrow();
  });

  it('returns the caller role with export history so the Web can enforce the role matrix', () => {
    expect(ExportListResponse.parse({ access_role: 'viewer', exports: [], next_cursor: null })).toEqual({
      access_role: 'viewer', exports: [], next_cursor: null,
    });
  });
});
