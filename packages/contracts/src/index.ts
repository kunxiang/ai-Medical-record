export * from './canonical.js';
export * from './scalars.js';
export * from './enums.js';
export * from './crop.js';
export * from './person.js';
export * from './document.js';
export * from './encounter.js';
export * from './sidecars.js';
export * from './journal.js';
export * from './errors.js';
export * from './auth.js';
export * from './ai.js';
export * from './jobs.js';
export * from './normalization.js';
export * from './multipart.js';
export * from './corrections.js';
export * from './processing.js';
export * from './metadata.js';
export * from './search.js';
export * from './exports.js';
export * from './context.js';
export * from './observation.js';
export * from './trends.js';
export * from './medication.js';

export const SCHEMA_VERSIONS = {
  capture: '2.0',
  page: '2.0',
  person: '1.0',
  journal: '1.0',
  manifest: '1.0',
  correction: '1.1',
  decision: '1.0',
} as const;
