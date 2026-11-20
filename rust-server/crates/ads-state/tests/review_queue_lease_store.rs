use ads_state::{
    StateDb, acquire_review_queue_lease, get_review_queue_lease, release_review_queue_lease,
    renew_review_queue_lease,
};
use tempfile::tempdir;

fn connection() -> (tempfile::TempDir, rusqlite::Connection) {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let connection = db.connect().expect("connection");
    (directory, connection)
}

#[test]
fn acquires_renews_and_releases_project_leases() {
    let (_directory, connection) = connection();
    assert_eq!(
        get_review_queue_lease(&connection, "project-1").expect("empty lease"),
        None
    );

    assert!(
        acquire_review_queue_lease(&connection, "project-1", "owner-a", 1_000, 2_000)
            .expect("acquire")
    );
    let lease = get_review_queue_lease(&connection, "project-1")
        .expect("lease")
        .expect("exists");
    assert_eq!(lease.owner_id, "owner-a");
    assert_eq!(lease.expires_at, 3_000);
    assert_eq!(lease.updated_at, 2_000);

    assert!(
        !acquire_review_queue_lease(&connection, "project-1", "owner-b", 1_000, 2_500)
            .expect("conflict")
    );
    assert_eq!(
        get_review_queue_lease(&connection, "project-1")
            .expect("lease")
            .expect("exists")
            .owner_id,
        "owner-a"
    );

    assert!(
        !renew_review_queue_lease(&connection, "project-1", "owner-b", 1_000, 2_600)
            .expect("wrong owner")
    );
    assert!(
        renew_review_queue_lease(&connection, "project-1", "owner-a", 1_000, 2_600).expect("renew")
    );
    let renewed = get_review_queue_lease(&connection, "project-1")
        .expect("lease")
        .expect("exists");
    assert_eq!(renewed.expires_at, 3_600);
    assert_eq!(renewed.updated_at, 2_600);

    release_review_queue_lease(&connection, "project-1", "owner-b").expect("release other owner");
    assert!(
        get_review_queue_lease(&connection, "project-1")
            .expect("lease")
            .is_some()
    );
    release_review_queue_lease(&connection, "project-1", "owner-a").expect("release owner");
    assert!(
        get_review_queue_lease(&connection, "project-1")
            .expect("lease")
            .is_none()
    );
}

#[test]
fn allows_taking_over_an_expired_lease_and_treats_non_positive_ttl_as_one() {
    let (_directory, connection) = connection();
    assert!(
        acquire_review_queue_lease(&connection, "project-1", "owner-a", 1_000, 1_000)
            .expect("acquire")
    );
    assert!(
        acquire_review_queue_lease(&connection, "project-1", "owner-b", 500, 2_000)
            .expect("expired takeover")
    );
    let lease = get_review_queue_lease(&connection, "project-1")
        .expect("lease")
        .expect("exists");
    assert_eq!(lease.owner_id, "owner-b");
    assert_eq!(lease.expires_at, 2_500);

    assert!(
        acquire_review_queue_lease(&connection, "project-2", "owner-a", 0, 3_000)
            .expect("zero ttl")
    );
    assert_eq!(
        get_review_queue_lease(&connection, "project-2")
            .expect("lease")
            .expect("exists")
            .expires_at,
        3_001
    );
    assert!(
        acquire_review_queue_lease(&connection, "project-3", "owner-a", -10, 4_000)
            .expect("negative ttl")
    );
    assert_eq!(
        get_review_queue_lease(&connection, "project-3")
            .expect("lease")
            .expect("exists")
            .expires_at,
        4_001
    );
}
