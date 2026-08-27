import {
  DecisionNormalizationConfirm, JOURNAL_EVENT_REGISTRY,
  JournalDocumentArchive, JournalPersonCheckAck,
} from '@amr/contracts';

export type HumanReplayItem =
  | {
    replayKind: 'document_archive';
    at: string;
    eventId: string;
    sourceKey: string;
    line: ReturnType<typeof JournalDocumentArchive.parse>;
  }
  | {
    replayKind: 'person_check_ack';
    at: string;
    eventId: string;
    sourceKey: string;
    line: ReturnType<typeof JournalPersonCheckAck.parse>;
  }
  | {
    replayKind: 'normalization_confirm';
    at: string;
    eventId: string;
    sourceKey: string;
    line: ReturnType<typeof DecisionNormalizationConfirm.parse>;
  };

export type HumanReplayParseResult = {
  items: HumanReplayItem[];
  reconciliation: string[];
};

function jsonObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function parseJournalObject(sourceKey: string, text: string): HumanReplayParseResult {
  const result: HumanReplayParseResult = { items: [], reconciliation: [] };
  for (const raw of text.split('\n').filter(Boolean)) {
    const object = jsonObject(raw);
    if (!object) {
      result.reconciliation.push(`非法 journal JSON (${sourceKey}): ${raw.slice(0, 120)}`);
      continue;
    }
    if (object['event'] === 'document_archive') {
      const parsed = JournalDocumentArchive.safeParse(object);
      if (!parsed.success) {
        result.reconciliation.push(`非法 document_archive (${sourceKey}): ${raw.slice(0, 120)}`);
        continue;
      }
      result.items.push({
        replayKind: 'document_archive', at: parsed.data.at,
        eventId: parsed.data.event_id, sourceKey, line: parsed.data,
      });
      continue;
    }
    if (object['event'] === 'person_check_ack') {
      const parsed = JournalPersonCheckAck.safeParse(object);
      if (!parsed.success) {
        result.reconciliation.push(`非法 person_check_ack (${sourceKey}): ${raw.slice(0, 120)}`);
        continue;
      }
      result.items.push({
        replayKind: 'person_check_ack', at: parsed.data.at,
        eventId: parsed.data.event_id, sourceKey, line: parsed.data,
      });
      continue;
    }
    const event = object['event'];
    if (typeof event !== 'string' || !(JOURNAL_EVENT_REGISTRY as readonly string[]).includes(event)) {
      result.reconciliation.push(`未知 journal 事件 (${sourceKey}): ${String(event)}`);
    }
    // 已登记的其他事件由 _person/capture/manifest/correction 等各自 L1 来源恢复。
  }
  return result;
}

export function parseDecisionObject(sourceKey: string, text: string): HumanReplayParseResult {
  const result: HumanReplayParseResult = { items: [], reconciliation: [] };
  for (const raw of text.split('\n').filter(Boolean)) {
    const object = jsonObject(raw);
    if (!object) {
      result.reconciliation.push(`非法 decision JSON (${sourceKey}): ${raw.slice(0, 120)}`);
      continue;
    }
    if (object['op'] !== 'normalization_confirm') {
      result.reconciliation.push(`未知 decision 操作 (${sourceKey}): ${String(object['op'])}`);
      continue;
    }
    const parsed = DecisionNormalizationConfirm.safeParse(object);
    if (!parsed.success) {
      result.reconciliation.push(`非法 normalization_confirm (${sourceKey}): ${raw.slice(0, 120)}`);
      continue;
    }
    result.items.push({
      replayKind: 'normalization_confirm', at: parsed.data.at,
      eventId: parsed.data.event_id, sourceKey, line: parsed.data,
    });
  }
  return result;
}

/** 跨 journal/decisions 全局排序，并与 manifest 共用 event_id 幂等集合。 */
export function orderedUniqueHumanReplay(
  items: HumanReplayItem[],
  seenEventIds: Set<string>,
): HumanReplayItem[] {
  const ordered = [...items].sort(
    (a, b) => a.at.localeCompare(b.at) || a.eventId.localeCompare(b.eventId),
  );
  return ordered.filter((item) => {
    if (seenEventIds.has(item.eventId)) return false;
    seenEventIds.add(item.eventId);
    return true;
  });
}
