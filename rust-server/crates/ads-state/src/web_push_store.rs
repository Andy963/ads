use rusqlite::{Connection, params};

use crate::StateResult;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredWebPushSubscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

pub fn ensure_web_push_tables(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS web_push_subscriptions (
           endpoint TEXT PRIMARY KEY,
           user_id TEXT NOT NULL,
           p256dh TEXT NOT NULL,
           auth TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_user
           ON web_push_subscriptions(user_id);",
    )?;
    Ok(())
}

pub fn save_web_push_subscription(
    connection: &mut Connection,
    user_id: &str,
    subscription: &StoredWebPushSubscription,
    now_secs: i64,
) -> StateResult<()> {
    let transaction = connection.transaction()?;
    transaction.execute(
        "DELETE FROM web_push_subscriptions WHERE user_id = ?1 AND endpoint != ?2",
        params![user_id, subscription.endpoint],
    )?;
    transaction.execute(
        "INSERT INTO web_push_subscriptions (endpoint, user_id, p256dh, auth, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(endpoint) DO UPDATE SET
           user_id = excluded.user_id,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           updated_at = excluded.updated_at",
        params![
            subscription.endpoint,
            user_id,
            subscription.p256dh,
            subscription.auth,
            now_secs,
            now_secs,
        ],
    )?;
    transaction.commit()?;
    Ok(())
}

pub fn remove_web_push_subscription(
    connection: &Connection,
    user_id: &str,
    endpoint: &str,
) -> StateResult<()> {
    connection.execute(
        "DELETE FROM web_push_subscriptions WHERE user_id = ?1 AND endpoint = ?2",
        params![user_id, endpoint],
    )?;
    Ok(())
}

pub fn list_web_push_subscriptions_by_user(
    connection: &Connection,
    user_id: &str,
) -> StateResult<Vec<StoredWebPushSubscription>> {
    let mut statement = connection.prepare(
        "SELECT endpoint, p256dh, auth
         FROM web_push_subscriptions
         WHERE user_id = ?1
         ORDER BY updated_at DESC, endpoint ASC",
    )?;
    let rows = statement.query_map(params![user_id], |row| {
        Ok(StoredWebPushSubscription {
            endpoint: row.get(0)?,
            p256dh: row.get(1)?,
            auth: row.get(2)?,
        })
    })?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row?);
    }
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::StateDb;
    use tempfile::tempdir;

    #[test]
    fn saves_replaces_lists_and_removes_user_subscriptions() {
        let dir = tempdir().expect("tempdir");
        let db = StateDb::open(dir.path().join("state.db")).expect("state db");
        let mut conn = db.connect().expect("connect");

        let sub1 = StoredWebPushSubscription {
            endpoint: "https://web.push.apple.com/sub-1".to_string(),
            p256dh: "p256dh-1".to_string(),
            auth: "auth-1".to_string(),
        };
        let sub2 = StoredWebPushSubscription {
            endpoint: "https://fcm.googleapis.com/fcm/send/sub-2".to_string(),
            p256dh: "p256dh-2".to_string(),
            auth: "auth-2".to_string(),
        };
        let other_user_sub = StoredWebPushSubscription {
            endpoint: "https://web.push.apple.com/sub-other".to_string(),
            p256dh: "p256dh-other".to_string(),
            auth: "auth-other".to_string(),
        };

        save_web_push_subscription(&mut conn, "user-1", &sub1, 100).expect("save sub1");
        save_web_push_subscription(&mut conn, "user-2", &other_user_sub, 101).expect("save user-2");
        assert_eq!(
            list_web_push_subscriptions_by_user(&conn, "user-1").expect("list"),
            vec![sub1.clone()]
        );

        // Saving a newer endpoint for user-1 replaces user-1's prior endpoint without affecting user-2.
        save_web_push_subscription(&mut conn, "user-1", &sub2, 102).expect("save sub2");
        assert_eq!(
            list_web_push_subscriptions_by_user(&conn, "user-1").expect("list"),
            vec![sub2.clone()]
        );
        assert_eq!(
            list_web_push_subscriptions_by_user(&conn, "user-2").expect("list"),
            vec![other_user_sub.clone()]
        );

        // Removing with wrong user does not delete user-1's subscription.
        remove_web_push_subscription(&conn, "user-2", &sub2.endpoint).expect("noop remove");
        assert_eq!(
            list_web_push_subscriptions_by_user(&conn, "user-1").expect("list"),
            vec![sub2.clone()]
        );

        remove_web_push_subscription(&conn, "user-1", &sub2.endpoint).expect("remove");
        assert!(
            list_web_push_subscriptions_by_user(&conn, "user-1")
                .expect("list")
                .is_empty()
        );
    }
}
