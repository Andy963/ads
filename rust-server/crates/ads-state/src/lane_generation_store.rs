use rusqlite::{Connection, OptionalExtension, params};

use crate::StateResult;

pub fn get_lane_generation(
    connection: &mut Connection,
    namespace: &str,
    lane_key: &str,
    now: i64,
) -> StateResult<i64> {
    let namespace = namespace.trim();
    let lane_key = lane_key.trim();
    if namespace.is_empty() || lane_key.is_empty() {
        return Ok(1);
    }

    let transaction = connection.transaction()?;
    transaction.execute(
        "INSERT OR IGNORE INTO web_lane_generations (namespace, lane_key, generation, updated_at)
         VALUES (?1, ?2, 1, ?3)",
        params![namespace, lane_key, now],
    )?;
    let generation = read_generation(&transaction, namespace, lane_key)?;
    transaction.commit()?;
    Ok(generation)
}

pub fn bump_lane_generation(
    connection: &mut Connection,
    namespace: &str,
    lane_key: &str,
    now: i64,
) -> StateResult<i64> {
    let namespace = namespace.trim();
    let lane_key = lane_key.trim();
    if namespace.is_empty() || lane_key.is_empty() {
        return Ok(1);
    }

    let transaction = connection.transaction()?;
    transaction.execute(
        "INSERT OR IGNORE INTO web_lane_generations (namespace, lane_key, generation, updated_at)
         VALUES (?1, ?2, 1, ?3)",
        params![namespace, lane_key, now],
    )?;
    transaction.execute(
        "UPDATE web_lane_generations
         SET generation = generation + 1, updated_at = ?1
         WHERE namespace = ?2 AND lane_key = ?3",
        params![now, namespace, lane_key],
    )?;
    let generation = read_generation(&transaction, namespace, lane_key)?;
    transaction.commit()?;
    Ok(generation)
}

fn read_generation(connection: &Connection, namespace: &str, lane_key: &str) -> StateResult<i64> {
    let generation = connection
        .query_row(
            "SELECT generation FROM web_lane_generations
             WHERE namespace = ?1 AND lane_key = ?2",
            params![namespace, lane_key],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(1);
    Ok(generation.max(1))
}
