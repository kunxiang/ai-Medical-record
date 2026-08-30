import { canonicalJsonString } from '@amr/contracts';

export interface SeriesDimensions {
  concept_code: string;
  qualifier: string | null;
  body_site: string | null;
  specimen: string | null;
  method: string | null;
  device: string | null;
  measurement_setting: string | null;
  extra_dims: Record<string, string> | null;
  result_kind: 'measured' | 'calculated' | 'input_parameter';
}

export function canonicalSeriesIdentity(input: SeriesDimensions): string {
  return canonicalJsonString({
    concept_code: input.concept_code,
    qualifier: input.qualifier,
    body_site: input.body_site,
    specimen: input.specimen,
    method: input.method,
    device: input.device,
    measurement_setting: input.measurement_setting,
    extra_dims: input.extra_dims,
    result_kind: input.result_kind,
  });
}
