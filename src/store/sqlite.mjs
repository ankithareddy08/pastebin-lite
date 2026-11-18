import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Local / persistent-disk hosting only. Vercel always uses the shared Redis store.
export function createSqliteStore(path) {
  const filename = resolve(path);
  mkdirSync(dirname(filename), { recursive: true });
  const database = new DatabaseSync(filename);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS pastes (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      expires_at INTEGER,
      remaining_views INTEGER CHECK (remaining_views IS NULL OR remaining_views >= 0)
    );
  `);
  // Version 1 stores JSON text so SQLite/Node string bindings cannot truncate
  // embedded NUL characters or replace lone UTF-16 surrogates. Upgrade any
  // earlier local rows automatically; a fresh database has nothing to convert.
  database.exec('BEGIN IMMEDIATE');
  try {
    if (database.prepare('PRAGMA user_version').get().user_version < 1) {
      database.exec('UPDATE pastes SET content = json_quote(content); PRAGMA user_version = 1;');
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    database.close();
    throw error;
  }
  const insert = database.prepare(`
    INSERT INTO pastes (id, content, expires_at, remaining_views)
    VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING
  `);
  // The eligibility check and decrement are a single statement, protected by
  // SQLite's write lock even when different app processes share this file.
  const consume = database.prepare(`
    UPDATE pastes
    SET remaining_views = CASE
      WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 0
      WHEN remaining_views IS NULL THEN NULL
      ELSE remaining_views - 1 END
    WHERE id = ?
      AND (remaining_views IS NULL OR remaining_views > 0)
    RETURNING content, remaining_views, expires_at
  `);
  const ping = database.prepare('SELECT 1 AS ok');

  return {
    health() { return ping.get().ok === 1; },
    create({ id, content, expiresAt, maxViews }) {
      return insert.run(id, JSON.stringify(content), expiresAt, maxViews).changes === 1;
    },
    consume(id, now) {
      const row = consume.get(now, id);
      // Observing expiry permanently exhausts the record, even if a test clock
      // subsequently moves backwards. This is part of the same atomic write.
      return row && (row.expires_at === null || now < row.expires_at) ? {
        content: JSON.parse(row.content),
        remaining_views: row.remaining_views,
        expires_at: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
      } : null;
    },
    close() { database.close(); },
  };
}
