import {
  DecisionNormalizationConfirm, JOURNAL_EVENT_REGISTRY,
  JournalContextAnswerUpsert, JournalContextMediaFinalize, JournalContextSessionUpsert,
  JournalDocumentArchive, JournalDocumentMetadataUpsert, JournalEncounterDocumentsSet,
  JournalEncounterUpsert, JournalPersonCheckAck, JournalObservationUpsert,
  JournalConceptAliasUpsert,
  JournalMetricGroupArchive, JournalMetricGroupUpsert,
  JournalMedicationUpsert, JournalTimelineEventUpsert,
} from '@amr/contracts';

export type HumanReplayItem =
  | {
    replayKind: 'document_metadata_upsert';
    at: string;
    eventId: string;
    sourceKey: string;
    line: ReturnType<typeof JournalDocumentMetadataUpsert.parse>;
  }
  | {
    replayKind: 'encounter_upsert';
    at: string;
    eventId: string;
    sourceKey: string;
    line: ReturnType<typeof JournalEncounterUpsert.parse>;
  }
  | {
    replayKind: 'encounter_documents_set';
    at: string;
    eventId: string;
    sourceKey: string;
    line: ReturnType<typeof JournalEncounterDocumentsSet.parse>;
  }
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
    replayKind: 'context_session_upsert';
    at: string;
    eventId: string;
    sourceKey: string;
    line: ReturnType<typeof JournalContextSessionUpsert.parse>;
  }
  | {
    replayKind: 'context_answer_upsert';
    at: string;
    eventId: string;
    sourceKey: string;
    line: ReturnType<typeof JournalContextAnswerUpsert.parse>;
  }
  | {
    replayKind: 'context_media_finalize';
    at: string;
    eventId: string;
    sourceKey: string;
    line: ReturnType<typeof JournalContextMediaFinalize.parse>;
  }
  | {
    replayKind: 'observation_upsert';
    at: string;
    eventId: string;
    sourceKey: string;
    line: ReturnType<typeof JournalObservationUpsert.parse>;
  }
  | {
    replayKind: 'concept_alias_upsert';
    at: string;
    eventId: string;
    sourceKey: string;
    line: ReturnType<typeof JournalConceptAliasUpsert.parse>;
  }
  | {
    replayKind: 'metric_group_upsert';
    at: string;
    eventId: string;
    sourceKey: string;
    line: ReturnType<typeof JournalMetricGroupUpsert.parse>;
  }
  | {
    replayKind: 'metric_group_archive';
    at: string;
    eventId: string;
    sourceKey: string;
    line: ReturnType<typeof JournalMetricGroupArchive.parse>;
  }
  | {
    replayKind: 'medication_upsert';
    at: string;
    eventId: string;
    sourceKey: string;
    line: ReturnType<typeof JournalMedicationUpsert.parse>;
  }
  | {
    replayKind: 'timeline_event_upsert';
    at: string;
    eventId: string;
    sourceKey: string;
    line: ReturnType<typeof JournalTimelineEventUpsert.parse>;
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
    if (object['event'] === 'document_metadata_upsert') {
      const parsed = JournalDocumentMetadataUpsert.safeParse(object);
      if (!parsed.success) {
        result.reconciliation.push(`非法 document_metadata_upsert (${sourceKey}): ${raw.slice(0, 120)}`);
        continue;
      }
      result.items.push({
        replayKind: 'document_metadata_upsert', at: parsed.data.at,
        eventId: parsed.data.event_id, sourceKey, line: parsed.data,
      });
      continue;
    }
    if (object['event'] === 'encounter_upsert') {
      const parsed = JournalEncounterUpsert.safeParse(object);
      if (!parsed.success) {
        result.reconciliation.push(`非法 encounter_upsert (${sourceKey}): ${raw.slice(0, 120)}`);
        continue;
      }
      result.items.push({
        replayKind: 'encounter_upsert', at: parsed.data.at,
        eventId: parsed.data.event_id, sourceKey, line: parsed.data,
      });
      continue;
    }
    if (object['event'] === 'encounter_documents_set') {
      const parsed = JournalEncounterDocumentsSet.safeParse(object);
      if (!parsed.success) {
        result.reconciliation.push(`非法 encounter_documents_set (${sourceKey}): ${raw.slice(0, 120)}`);
        continue;
      }
      result.items.push({
        replayKind: 'encounter_documents_set', at: parsed.data.at,
        eventId: parsed.data.event_id, sourceKey, line: parsed.data,
      });
      continue;
    }
    if (object['event'] === 'context_session_upsert') {
      const parsed = JournalContextSessionUpsert.safeParse(object);
      if (!parsed.success) {
        result.reconciliation.push(`非法 context_session_upsert (${sourceKey}): ${raw.slice(0, 120)}`);
        continue;
      }
      result.items.push({
        replayKind: 'context_session_upsert', at: parsed.data.at,
        eventId: parsed.data.event_id, sourceKey, line: parsed.data,
      });
      continue;
    }
    if (object['event'] === 'context_answer_upsert') {
      const parsed = JournalContextAnswerUpsert.safeParse(object);
      if (!parsed.success) {
        result.reconciliation.push(`非法 context_answer_upsert (${sourceKey}): ${raw.slice(0, 120)}`);
        continue;
      }
      result.items.push({
        replayKind: 'context_answer_upsert', at: parsed.data.at,
        eventId: parsed.data.event_id, sourceKey, line: parsed.data,
      });
      continue;
    }
    if (object['event'] === 'context_media_finalize') {
      const parsed = JournalContextMediaFinalize.safeParse(object);
      if (!parsed.success) {
        result.reconciliation.push(`非法 context_media_finalize (${sourceKey}): ${raw.slice(0, 120)}`);
        continue;
      }
      result.items.push({
        replayKind: 'context_media_finalize', at: parsed.data.at,
        eventId: parsed.data.event_id, sourceKey, line: parsed.data,
      });
      continue;
    }
    if (object['event'] === 'observation_upsert') {
      const parsed = JournalObservationUpsert.safeParse(object);
      if (!parsed.success) {
        result.reconciliation.push(`非法 observation_upsert (${sourceKey}): ${raw.slice(0, 120)}`);
        continue;
      }
      result.items.push({
        replayKind: 'observation_upsert', at: parsed.data.at,
        eventId: parsed.data.event_id, sourceKey, line: parsed.data,
      });
      continue;
    }
    if (object['event'] === 'concept_alias_upsert') {
      const parsed = JournalConceptAliasUpsert.safeParse(object);
      if (!parsed.success) {
        result.reconciliation.push(`非法 concept_alias_upsert (${sourceKey}): ${raw.slice(0, 120)}`);
        continue;
      }
      result.items.push({
        replayKind: 'concept_alias_upsert', at: parsed.data.at,
        eventId: parsed.data.event_id, sourceKey, line: parsed.data,
      });
      continue;
    }
    if (object['event'] === 'metric_group_upsert') {
      const parsed = JournalMetricGroupUpsert.safeParse(object);
      if (!parsed.success) {
        result.reconciliation.push(`非法 metric_group_upsert (${sourceKey}): ${raw.slice(0, 120)}`);
        continue;
      }
      result.items.push({
        replayKind: 'metric_group_upsert', at: parsed.data.at,
        eventId: parsed.data.event_id, sourceKey, line: parsed.data,
      });
      continue;
    }
    if (object['event'] === 'metric_group_archive') {
      const parsed = JournalMetricGroupArchive.safeParse(object);
      if (!parsed.success) {
        result.reconciliation.push(`非法 metric_group_archive (${sourceKey}): ${raw.slice(0, 120)}`);
        continue;
      }
      result.items.push({
        replayKind: 'metric_group_archive', at: parsed.data.at,
        eventId: parsed.data.event_id, sourceKey, line: parsed.data,
      });
      continue;
    }
    if (object['event'] === 'medication_upsert') {
      const parsed = JournalMedicationUpsert.safeParse(object);
      if (!parsed.success) {
        result.reconciliation.push(`非法 medication_upsert (${sourceKey}): ${raw.slice(0, 120)}`);
        continue;
      }
      result.items.push({
        replayKind: 'medication_upsert', at: parsed.data.at,
        eventId: parsed.data.event_id, sourceKey, line: parsed.data,
      });
      continue;
    }
    if (object['event'] === 'timeline_event_upsert') {
      const parsed = JournalTimelineEventUpsert.safeParse(object);
      if (!parsed.success) {
        result.reconciliation.push(`非法 timeline_event_upsert (${sourceKey}): ${raw.slice(0, 120)}`);
        continue;
      }
      result.items.push({
        replayKind: 'timeline_event_upsert', at: parsed.data.at,
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
