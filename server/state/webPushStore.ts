import type { Database as DatabaseType } from "better-sqlite3";

export type StoredWebPushSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export function ensureWebPushTables(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_user
      ON web_push_subscriptions(user_id);
  `);
}

export function createWebPushStore(db: DatabaseType) {
  ensureWebPushTables(db);

  return {
    save(userId: string, subscription: StoredWebPushSubscription): void {
      const now = Math.floor(Date.now() / 1000);
      const saveSubscription = db.transaction(() => {
        db.prepare("DELETE FROM web_push_subscriptions WHERE user_id = ? AND endpoint != ?")
          .run(userId, subscription.endpoint);
        db.prepare(`
          INSERT INTO web_push_subscriptions (endpoint, user_id, p256dh, auth, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(endpoint) DO UPDATE SET
            user_id = excluded.user_id,
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            updated_at = excluded.updated_at
        `).run(subscription.endpoint, userId, subscription.keys.p256dh, subscription.keys.auth, now, now);
      });
      saveSubscription();
    },

    remove(userId: string, endpoint: string): void {
      db.prepare("DELETE FROM web_push_subscriptions WHERE user_id = ? AND endpoint = ?").run(userId, endpoint);
    },

    listByUser(userId: string): StoredWebPushSubscription[] {
      const rows = db.prepare(`
        SELECT endpoint, p256dh, auth
        FROM web_push_subscriptions
        WHERE user_id = ?
      `).all(userId) as Array<{ endpoint: string; p256dh: string; auth: string }>;

      return rows.map((row) => ({
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      }));
    },
  };
}
