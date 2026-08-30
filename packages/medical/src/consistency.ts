export type ConsistencyFlag =
  | 'reference_bounds_reversed'
  | 'numeric_raw_mismatch'
  | 'numeric_unit_missing'
  | 'derived_inputs_missing';

export function observationConsistencyFlags(input: {
  value_raw: string;
  value_num: number | null;
  unit_raw: string | null;
  ref_low: number | null;
  ref_high: number | null;
  is_derived?: boolean;
  input_observation_ids?: readonly string[] | null;
}): ConsistencyFlag[] {
  const flags: ConsistencyFlag[] = [];
  if (input.ref_low !== null && input.ref_high !== null && input.ref_low > input.ref_high) {
    flags.push('reference_bounds_reversed');
  }
  if (input.value_num !== null && input.unit_raw === null) flags.push('numeric_unit_missing');
  const rawNumber = input.value_raw.match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)/)?.[0];
  if (input.value_num !== null && rawNumber !== undefined
      && Math.abs(Number(rawNumber) - input.value_num) > Math.max(1e-9, Math.abs(input.value_num) * 1e-6)) {
    flags.push('numeric_raw_mismatch');
  }
  if (input.is_derived && !input.input_observation_ids?.length) flags.push('derived_inputs_missing');
  return flags;
}
