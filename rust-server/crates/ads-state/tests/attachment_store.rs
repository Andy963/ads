use ads_contract::attachments::AttachmentKind;
use ads_state::{AttachmentStore, CreateImageAttachment, StateError, WorkspaceDb};
use tempfile::tempdir;

fn create_input(
    sha256: &str,
    filename: Option<&str>,
    task_id: Option<&str>,
) -> CreateImageAttachment {
    CreateImageAttachment {
        task_id: task_id.map(str::to_string),
        filename: filename.map(str::to_string),
        content_type: "image/png".to_string(),
        size_bytes: 128,
        width: 16,
        height: 8,
        sha256: sha256.to_string(),
        storage_key: format!("attachments/{}/{}.png", &sha256[..2], sha256),
        now: Some(100),
    }
}

#[test]
fn attachment_creation_deduplicates_by_sha_and_backfills_only_empty_filenames() {
    let directory = tempdir().expect("temp dir");
    let db = WorkspaceDb::open(directory.path().join("ads.db")).expect("workspace db");
    let connection = db.connect().expect("connection");
    let store = AttachmentStore::new(&connection, "workspace-test");
    let sha = "A".repeat(64);

    let created = store
        .create_or_get_image_attachment(create_input(&sha, Some("C:\\fakepath\\photo.png"), None))
        .expect("create attachment");
    assert_eq!(created.kind, AttachmentKind::Image);
    assert_eq!(created.filename.as_deref(), Some("photo.png"));
    assert_eq!(created.sha256, sha.to_ascii_lowercase());
    assert_eq!(created.content_type, "image/png");
    assert_eq!(created.size_bytes, 128);
    assert_eq!(created.width, 16);
    assert_eq!(created.height, 8);
    assert_eq!(created.created_at, 100);

    let duplicate = store
        .create_or_get_image_attachment(create_input(
            &sha.to_ascii_lowercase(),
            Some("other.png"),
            None,
        ))
        .expect("deduplicate attachment");
    assert_eq!(duplicate.id, created.id);
    assert_eq!(duplicate.filename.as_deref(), Some("photo.png"));

    let missing_filename_sha = "b".repeat(64);
    let missing = store
        .create_or_get_image_attachment(create_input(&missing_filename_sha, None, None))
        .expect("create without filename");
    assert!(missing.filename.is_none());
    let backfilled = store
        .create_or_get_image_attachment(create_input(
            &missing_filename_sha,
            Some("filled.png"),
            None,
        ))
        .expect("backfill filename");
    assert_eq!(backfilled.id, missing.id);
    assert_eq!(backfilled.filename.as_deref(), Some("filled.png"));
    let fetched = store
        .get_attachment_by_sha256(&missing_filename_sha)
        .expect("read by sha")
        .expect("attachment exists");
    assert_eq!(fetched.filename.as_deref(), Some("filled.png"));

    assert!(
        store
            .get_attachment_by_sha256("not-a-sha")
            .expect("invalid sha lookup")
            .is_none()
    );
    let error = store
        .create_or_get_image_attachment(create_input("bad", None, None))
        .expect_err("invalid sha rejected");
    assert!(matches!(error, StateError::InvalidInput(_)));
}

#[test]
fn attachment_filenames_are_cleaned_and_limited_to_utf16_units() {
    let directory = tempdir().expect("temp dir");
    let db = WorkspaceDb::open(directory.path().join("ads.db")).expect("workspace db");
    let connection = db.connect().expect("connection");
    let store = AttachmentStore::new(&connection, "workspace-test");

    let filename = "folder/bad\u{0000}\u{001f}name\u{007f}.png".to_string();
    let attachment = store
        .create_or_get_image_attachment(create_input(&"c".repeat(64), Some(&filename), None))
        .expect("create attachment");
    assert_eq!(attachment.filename.as_deref(), Some("badname.png"));

    let long_filename = "a".repeat(250);
    let long = store
        .create_or_get_image_attachment(create_input(&"d".repeat(64), Some(&long_filename), None))
        .expect("create long attachment");
    assert_eq!(long.filename.as_deref(), Some("a".repeat(200).as_str()));

    let empty = store
        .create_or_get_image_attachment(create_input(&"e".repeat(64), Some(" \t "), None))
        .expect("create empty filename");
    assert!(empty.filename.is_none());
}

#[test]
fn attachments_claim_tasks_idempotently_and_reject_conflicts() {
    let directory = tempdir().expect("temp dir");
    let db = WorkspaceDb::open(directory.path().join("ads.db")).expect("workspace db");
    let connection = db.connect().expect("connection");
    for task_id in ["task-1", "task-2"] {
        connection
            .execute(
                "INSERT INTO tasks (id, title, prompt, created_at, workspace_id)
                 VALUES (?1, 'Task', 'Prompt', 1, 'workspace-test')",
                rusqlite::params![task_id],
            )
            .expect("insert task");
    }
    let store = AttachmentStore::new(&connection, "workspace-test");
    let first = store
        .create_or_get_image_attachment(create_input(&"1".repeat(64), Some("first.png"), None))
        .expect("first attachment");
    let second = store
        .create_or_get_image_attachment(create_input(&"2".repeat(64), Some("second.png"), None))
        .expect("second attachment");

    store
        .assign_attachments_to_task("task-1", std::slice::from_ref(&first.id))
        .expect("assign first task");
    store
        .assign_attachments_to_task("task-1", std::slice::from_ref(&first.id))
        .expect("idempotent assign");
    let assigned = store
        .get_attachment(&first.id)
        .expect("read first")
        .expect("first exists");
    assert_eq!(assigned.task_id.as_deref(), Some("task-1"));

    let listed = store
        .list_attachments_for_task("task-1")
        .expect("list task attachments");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, first.id);
    assert!(
        store
            .list_attachments_for_task(" ")
            .expect("empty task")
            .is_empty()
    );

    let conflict = store
        .assign_attachments_to_task("task-2", std::slice::from_ref(&first.id))
        .expect_err("conflicting assignment rejected");
    assert!(matches!(conflict, StateError::InvalidInput(_)));
    let missing = store
        .assign_attachments_to_task("task-2", &["missing".to_string()])
        .expect_err("missing attachment rejected");
    assert!(matches!(missing, StateError::InvalidInput(_)));

    store
        .assign_attachments_to_task(
            "task-2",
            &[second.id.clone(), first.id.clone(), first.id.clone()],
        )
        .expect_err("duplicate id still conflicts");
    assert!(
        store
            .get_attachment(&second.id)
            .expect("read second")
            .expect("second exists")
            .task_id
            .is_none(),
        "failed assignment must roll back earlier ids"
    );

    store
        .assign_attachments_to_task("task-2", std::slice::from_ref(&second.id))
        .expect("assign second task");
    assert_eq!(
        store
            .get_attachment(&second.id)
            .expect("read second")
            .expect("second exists")
            .task_id
            .as_deref(),
        Some("task-2")
    );
}
