export { Migrator } from './migrator.js';
export type { Migration } from './migrator.js';

import type { Migration } from './migrator.js';

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial schema — conversations, messages, users, audit_log',
    up(_db) {
      // This is the initial schema that Database already creates.
      // Keep it here for documentation and future reference.
      // The actual table creation is already handled by Database constructor.
      // This migration is marked as "applied" retroactively.
    },
  },
  {
    version: 2,
    description: 'Add plugin_skills table for tracking loaded external plugins',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS plugin_skills (
          name TEXT PRIMARY KEY,
          file_path TEXT NOT NULL,
          version TEXT NOT NULL,
          loaded_at TEXT NOT NULL DEFAULT (datetime('now')),
          enabled INTEGER NOT NULL DEFAULT 1
        )
      `);
    },
  },
];
