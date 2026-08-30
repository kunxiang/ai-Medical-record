import type { AccessRoleT, ExportJobT } from '@amr/contracts';

export interface ExportActionPolicy {
  canDownload: boolean;
  canRetry: boolean;
  canRegenerateStale: boolean;
  canShare: boolean;
}

export function exportActionPolicy(
  role: AccessRoleT | null,
  job: Pick<ExportJobT, 'state' | 'artifact_available' | 'stale'>,
): ExportActionPolicy {
  const canEdit = role === 'owner' || role === 'editor';
  const completedArtifact = job.state === 'done' && job.artifact_available;
  return {
    canDownload: role !== null && completedArtifact,
    canRetry: canEdit && (job.state === 'failed' || (job.state === 'done' && !job.artifact_available)),
    canRegenerateStale: canEdit && job.stale,
    canShare: role === 'owner' && completedArtifact,
  };
}
