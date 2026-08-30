import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CapabilitiesResponse, ProcessingCapability,
  type CapabilitiesResponseT, type ProcessingModeT,
} from '@amr/contracts';
import { env } from '../env.js';
import { defineRoute } from '../define-route.js';
import { availablePlugins } from '../processing/queue.js';

type AvailablePlugin = Awaited<ReturnType<typeof availablePlugins>>[number];

export function buildCapabilities(
  processingMode: ProcessingModeT,
  plugins: AvailablePlugin[],
): CapabilitiesResponseT {
  const active = processingMode === 'assist' ? plugins : [];
  const provided = new Set(active.flatMap((plugin) => plugin.capabilities));
  return CapabilitiesResponse.parse({
    processing_mode: processingMode,
    core: {
      document_metadata: true,
      keyword_search: true,
      context: true,
      observations: true,
      trends: true,
      exports: true,
    },
    assist: {
      available: active.length > 0,
      plugins: active.map((plugin) => ({
        plugin_id: plugin.pluginId,
        plugin_version: plugin.pluginVersion,
        capabilities: plugin.capabilities,
        last_heartbeat_at: plugin.lastHeartbeatAt.toISOString(),
        metadata: plugin.metadata,
      })),
      capabilities: ProcessingCapability.options.filter((capability) => provided.has(capability)),
    },
  });
}

export function registerCapabilityRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/capabilities',
    input: z.object({}).strict(),
    output: CapabilitiesResponse,
    handler: async () => buildCapabilities(
      env.processingMode,
      env.processingMode === 'assist' ? await availablePlugins() : [],
    ),
  });
}
