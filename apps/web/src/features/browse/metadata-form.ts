import type {
  DocumentDetailResponseT, DocumentMetadataPatchT, ManualMetadataFieldT, MetadataSuggestionT,
} from '@amr/contracts';

export type EditableMetadataField = Exclude<ManualMetadataFieldT, 'facility_id'>;
export type MetadataForm = Record<EditableMetadataField, string>;

export function initialMetadataForm(detail: DocumentDetailResponseT): MetadataForm {
  const metadata = detail.effective_metadata;
  return {
    doc_type: metadata.doc_type.value ?? 'unknown',
    sampled_on: metadata.sampled_on.value ?? '',
    reported_on: metadata.reported_on.value ?? '',
    facility_name_raw: metadata.facility_name.value ?? '',
    department: metadata.department.value ?? '',
    title: metadata.title.value ?? '',
    note: metadata.note.value ?? '',
  };
}

export function buildMetadataPatch(input: {
  form: MetadataForm;
  dirty: ReadonlySet<EditableMetadataField>;
  revision: number;
  operationId: string;
}): DocumentMetadataPatchT {
  const optional = (field: Exclude<EditableMetadataField, 'doc_type'>) => (
    input.dirty.has(field) ? { [field]: input.form[field] || null } : {}
  );
  return {
    client_operation_id: input.operationId,
    if_revision: input.revision,
    ...(input.dirty.has('doc_type') ? { doc_type: input.form.doc_type as DocumentMetadataPatchT['doc_type'] } : {}),
    ...optional('sampled_on'),
    ...optional('reported_on'),
    ...optional('department'),
    ...optional('title'),
    ...optional('note'),
    ...(input.dirty.has('facility_name_raw') ? {
      facility_id: null,
      facility_name_raw: input.form.facility_name_raw || null,
    } : {}),
  } as DocumentMetadataPatchT;
}

export function selectableSuggestionFields(suggestion: MetadataSuggestionT): ManualMetadataFieldT[] {
  return Object.entries(suggestion.values)
    .filter(([, value]) => value !== undefined)
    .map(([field]) => field as ManualMetadataFieldT)
    .filter((field) => !suggestion.accepted_fields.includes(field));
}
