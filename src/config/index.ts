/**
 * Configuration Manager — Barrel Export
 *
 * Import order matters: schema.ts loads the config file from disk,
 * then migrations.ts runs all one-time data migrations on the loaded data,
 * then the remaining modules are loaded (they all reference the shared configData).
 *
 * All public exports are re-exported here so that consumers can do:
 *   import { config, updateSettings, ... } from './config/index.js';
 */

// 1. Schema first — loads config from disk and initialises configData
export { configData, saveConfigFile, CONFIG_FILE, ZYCLOPS_DEFAULT_ENDPOINT } from './schema.js';
export type { ConfigData } from './schema.js';

// 2. Migrations — runs all one-time data migrations (side-effect import)
import './migrations.js';

// 3. Accessors — the main `config` object consumed by the app
export { config } from './accessors.js';

// 4. Indexer CRUD
export { getIndexers, addIndexer, updateIndexer, deleteIndexer, reorderIndexers, reorderSyncedIndexers } from './indexerCrud.js';

// 5. Settings updater
export { updateSettings } from './settingsUpdater.js';

// 6. Provider CRUD
export { getProviders, addProvider, updateProvider, deleteProvider, reorderProviders } from './providerCrud.js';
