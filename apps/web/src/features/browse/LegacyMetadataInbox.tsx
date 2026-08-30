import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ManualMetadataFieldT, MetadataMigrationInboxResponseT } from '@amr/contracts';
import { ArchiveRestore, CheckCheck, ChevronDown, ChevronUp, LoaderCircle } from 'lucide-react';
import { uuidv7 } from 'uuidv7';
import { api } from '../../api/client.js';
import { Alert } from '../../ui/Alert.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';

const LABEL: Record<ManualMetadataFieldT, string> = {
  doc_type: '文档类型', sampled_on: '采样日期', reported_on: '报告日期',
  facility_id: '标准机构', facility_name_raw: '机构名称', department: '科室',
  title: '标题', note: '备注',
};

type InboxItem = MetadataMigrationInboxResponseT['items'][number];

function availableFields(item: InboxItem): ManualMetadataFieldT[] {
  return Object.entries(item.suggestion.values)
    .filter(([, value]) => value !== undefined)
    .map(([field]) => field as ManualMetadataFieldT)
    .filter((field) => !item.suggestion.accepted_fields.includes(field));
}

function effectiveValue(item: InboxItem, field: ManualMetadataFieldT): unknown {
  if (field === 'facility_name_raw') return item.effective_metadata.facility_name.value;
  if (field === 'facility_id') return null;
  return item.effective_metadata[field]?.value;
}

function show(value: unknown): string {
  return value === null || value === undefined || value === '' ? '（空）' : String(value);
}

export function LegacyMetadataInbox({
  personId,
  onChanged,
}: {
  personId: string;
  onChanged: () => void;
}): JSX.Element {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [selected, setSelected] = useState<Record<string, ManualMetadataFieldT[]>>({});
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.metadataMigrationInbox(personId);
      setItems(result.items);
      setSelected(Object.fromEntries(result.items.map((item) => [item.document_id, availableFields(item)])));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '历史建议加载失败');
    } finally {
      setLoading(false);
    }
  }, [personId]);

  useEffect(() => { void load(); }, [load]);

  const selectedCount = useMemo(
    () => Object.values(selected).reduce((sum, fields) => sum + fields.length, 0),
    [selected],
  );

  const acceptSelected = async () => {
    const requests = items.flatMap((item) => {
      const fields = selected[item.document_id] ?? [];
      return fields.length ? [{
        document_id: item.document_id,
        suggestion_id: item.suggestion.id,
        client_operation_id: uuidv7(),
        if_revision: item.current_revision,
        fields,
        overrides: {},
      }] : [];
    });
    if (requests.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.batchAcceptMetadataSuggestions({ items: requests });
      const failures = result.results.filter((entry) => !entry.ok);
      if (failures.length) {
        setError(`${failures.length} 份文档发生冲突，已保留待处理；其余项目已保存。`);
      }
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '批量接受建议失败');
    } finally {
      setSubmitting(false);
    }
  };

  if (!loading && items.length === 0 && !error) return <></>;

  return (
    <Card className="space-y-3" data-testid="legacy-metadata-inbox">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-warning-bg text-warning-text">
            <ArchiveRestore size={18} />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-bold text-ink">历史建议收件箱</h2>
              <Badge variant="warning">{items.length} 份</Badge>
            </div>
            <p className="text-xs text-muted">这些旧识别值仍只是建议；确认后才成为人工事实。</p>
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          iconRight={expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起' : '审核'}
        </Button>
      </div>

      {error && <Alert variant="warning"><span>{error}</span></Alert>}
      {loading && <div className="flex items-center gap-2 text-xs text-muted"><LoaderCircle className="animate-spin" size={14} />正在读取历史建议…</div>}

      {expanded && items.length > 0 && (
        <div className="space-y-3 border-t border-line pt-3">
          {items.map((item) => (
            <div key={item.document_id} className="space-y-2 rounded-xl border border-line bg-surface-subtle/60 p-3">
              <div className="flex items-center justify-between gap-2">
                <strong className="text-xs text-ink">文档 {item.document_id.slice(0, 8)}</strong>
                <Badge variant="neutral">revision {item.current_revision}</Badge>
              </div>
              {availableFields(item).map((field) => {
                const current = selected[item.document_id] ?? [];
                return (
                  <label key={field} className="grid cursor-pointer grid-cols-[auto_5rem_1fr] gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-brand-600"
                      checked={current.includes(field)}
                      onChange={(event) => setSelected((state) => ({
                        ...state,
                        [item.document_id]: event.target.checked
                          ? [...current, field]
                          : current.filter((value) => value !== field),
                      }))}
                    />
                    <strong>{LABEL[field]}</strong>
                    <span><span className="text-muted">{show(effectiveValue(item, field))} → </span>{show(item.suggestion.values[field as keyof typeof item.suggestion.values])}</span>
                  </label>
                );
              })}
            </div>
          ))}
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="primary"
              iconLeft={<CheckCheck size={14} />}
              loading={submitting}
              disabled={selectedCount === 0}
              onClick={() => void acceptSelected()}
            >
              接受选中字段（{selectedCount}）
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
