import { CapabilitiesResponse, type CapabilitiesResponseT } from '@amr/contracts';

export type CapabilityStatus = 'loading' | 'known' | 'unknown';

/** 网络/解析失败时唯一允许的回退：完整 core + 完全关闭 assist。 */
export const CORE_ONLY_CAPABILITIES: CapabilitiesResponseT = CapabilitiesResponse.parse({
  processing_mode: 'off',
  core: {
    document_metadata: true, keyword_search: true, context: true,
    observations: true, trends: true, exports: true,
  },
  assist: { available: false, plugins: [], capabilities: [] },
});

export function failClosedCapabilityState(): {
  capabilities: CapabilitiesResponseT;
  status: Extract<CapabilityStatus, 'unknown'>;
} {
  return { capabilities: CORE_ONLY_CAPABILITIES, status: 'unknown' };
}
