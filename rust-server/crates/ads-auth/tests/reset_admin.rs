use std::time::Duration;

use ads_auth::{
    AuthConfig, AuthError, AuthService, LoginOutcome, RequestMetadata, ResetAdminOutcome,
    hash_password_scrypt,
};
use ads_state::{StateDb, StateError, insert_user};
use tempfile::TempDir;

fn test_auth() -> (AuthService, TempDir) {
    let directory = tempfile::tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let auth = AuthService::new(
        db,
        AuthConfig {
            session_ttl_seconds: 3_600,
            session_pepper: "test-pepper".to_string(),
            sliding_sessions: false,
            login_max_attempts: 5,
            login_base_lockout: Duration::from_secs(1),
        },
    );
    (auth, directory)
}

fn login(auth: &AuthService, username: &str, password: &str) -> LoginOutcome {
    let request = ads_contract::auth::LoginRequest {
        username: username.to_string(),
        password: password.to_string(),
    };
    auth.login_at(&request, &RequestMetadata::default(), 1_700_000_000)
        .expect("login")
}

#[test]
fn reset_admin_creates_updates_and_revokes_sessions() {
    let (auth, _directory) = test_auth();

    let created = auth
        .reset_admin_at("admin", "secret", 1_700_000_000)
        .expect("create admin");
    let ResetAdminOutcome::Created { username, .. } = created else {
        panic!("expected created outcome");
    };
    assert_eq!(username, "admin");
    assert!(matches!(
        login(&auth, "admin", "secret"),
        LoginOutcome::Success { .. }
    ));

    let LoginOutcome::Success { token, .. } = login(&auth, "admin", "secret") else {
        panic!("expected login success");
    };
    let updated = auth
        .reset_admin_at("new-admin", "new-secret", 1_700_000_010)
        .expect("update admin");
    let ResetAdminOutcome::Updated {
        username,
        previous_username,
        ..
    } = updated
    else {
        panic!("expected updated outcome");
    };
    assert_eq!(username, "new-admin");
    assert_eq!(previous_username, "admin");

    assert!(
        auth.authenticate_at(&token, &RequestMetadata::default(), 1_700_000_020)
            .expect("authenticate old session")
            .is_none(),
        "reset-admin must revoke active sessions"
    );
    assert!(matches!(
        login(&auth, "admin", "secret"),
        LoginOutcome::Unauthorized
    ));
    assert!(matches!(
        login(&auth, "new-admin", "new-secret"),
        LoginOutcome::Success { .. }
    ));
}

#[test]
fn reset_admin_rejects_username_collision_without_mutation() {
    let (auth, _directory) = test_auth();
    let db = auth.db();
    insert_user(
        db,
        "user-1",
        "admin",
        &hash_password_scrypt("secret"),
        1_700_000_000,
    )
    .expect("first user");
    insert_user(
        db,
        "user-2",
        "other",
        &hash_password_scrypt("other-secret"),
        1_700_000_001,
    )
    .expect("second user");

    let error = auth
        .reset_admin_at("other", "changed", 1_700_000_010)
        .expect_err("collision must fail");
    let AuthError::State(StateError::InvalidInput(message)) = error else {
        panic!("expected invalid input error");
    };
    assert_eq!(message, "username already exists: other");
    assert!(matches!(
        login(&auth, "admin", "secret"),
        LoginOutcome::Success { .. }
    ));
    assert!(matches!(
        login(&auth, "other", "other-secret"),
        LoginOutcome::Success { .. }
    ));
}
