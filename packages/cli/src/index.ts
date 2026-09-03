/**
 * InkPi CLI surface — headless print mode and the extension package-manager
 * command dispatcher.
 *
 * These used to live inside `@inkpi/agent-core`; they were moved here so the
 * domain core stays free of process/CLI concerns (see architecture audit C11,
 * review §2.7-4). The CLI depends on the core (one-directional) and must never
 * be imported by it.
 */

export * from './print-mode.js';
export * from './package-manager-cli.js';
