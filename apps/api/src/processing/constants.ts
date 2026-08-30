/** Worker 失联超过此 lease 后，任务可由其他实例回收。 */
export const DEFAULT_PROCESSING_LEASE_MS = 15 * 60_000;
export const ACTIVE_PLUGIN_MAX_AGE_MS = 90_000;
