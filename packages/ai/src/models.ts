/**
 * Lightweight model catalog entry point.
 *
 * This subpath exposes static model data, catalog helpers, and presets without
 * importing provider transports, image generation, OAuth, or stream adapters.
 */
export * from './models.generated.js';
export * from './catalog.js';
export * from './presets.js';
export type * from './types.js';
