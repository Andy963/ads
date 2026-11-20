use std::fs;
use std::path::Path;

use ads_state::{
    StateDb, UpstreamCredentialStore, UpstreamCredentials, normalize_upstream_base_url,
};
use rusqlite::Connection;
use serde_json::Value;

fn memory_db() -> Connection {
    let connection = Connection::open_in_memory().expect("memory db");
    connection
        .execute_batch(
            "CREATE TABLE kv_state (
               namespace TEXT NOT NULL,
               key TEXT NOT NULL,
               value TEXT NOT NULL,
               updated_at INTEGER NOT NULL,
               PRIMARY KEY(namespace, key)
             );",
        )
        .expect("kv_state");
    connection
}

#[test]
fn decrypts_a_typescript_credential_envelope() {
    let vector: Value = serde_json::from_str(include_str!(
        "../../../contracts/state/upstream-credential-vector.json"
    ))
    .expect("vector");
    let connection = memory_db();
    connection
        .execute(
            "INSERT INTO kv_state (namespace, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                "web_upstream_credentials",
                vector["record_key"].as_str().expect("record key"),
                vector["envelope"].to_string(),
                1
            ],
        )
        .expect("insert");

    let store = UpstreamCredentialStore::with_pepper(
        vector["pepper"].as_str().expect("pepper").to_string(),
    );
    let credentials = store
        .get_credentials(
            &connection,
            vector["owner"].as_str().expect("owner"),
            vector["profile"].as_str(),
        )
        .expect("decrypt")
        .expect("credentials");
    assert_eq!(credentials.base_url, "https://api.example.com/v1");
    assert_eq!(credentials.provider, "provider-fixture");
    assert_eq!(credentials.api_key, "fixture-api-key");
}

#[test]
fn saves_profile_bound_credentials_and_reads_metadata() {
    let connection = memory_db();
    let store = UpstreamCredentialStore::with_pepper("test-pepper");
    store
        .save(
            &connection,
            "owner-1",
            &UpstreamCredentials {
                base_url: "https://API.Example.com/v1/chat/completions".to_string(),
                provider: "provider-1".to_string(),
                api_key: "  secret-key  ".to_string(),
            },
            Some("provider-1"),
        )
        .expect("save");

    let metadata = store
        .get_metadata(&connection, "owner-1", Some("provider-1"))
        .expect("metadata")
        .expect("exists");
    assert_eq!(metadata.base_url, "https://api.example.com/v1");
    assert!(metadata.has_api_key);

    let credentials = store
        .get_credentials(&connection, "owner-1", Some("provider-1"))
        .expect("credentials")
        .expect("exists");
    assert_eq!(credentials.api_key, "secret-key");
    assert!(
        store
            .get_credentials(&connection, "owner-1", Some("other-profile"))
            .expect("other profile")
            .is_none()
    );
}

#[test]
fn rejects_credentials_moved_to_another_profile() {
    let connection = memory_db();
    let store = UpstreamCredentialStore::with_pepper("test-pepper");
    store
        .save(
            &connection,
            "owner-1",
            &UpstreamCredentials {
                base_url: "https://api.example.com/v1".to_string(),
                provider: "provider-1".to_string(),
                api_key: "secret-key".to_string(),
            },
            Some("profile-a"),
        )
        .expect("save");
    let value: String = connection
        .query_row("SELECT value FROM kv_state", [], |row| row.get(0))
        .expect("value");
    connection
        .execute(
            "INSERT INTO kv_state (namespace, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                "web_upstream_credentials",
                "owner-1\u{0}profile:profile-b",
                value,
                1
            ],
        )
        .expect("moved record");

    let error = store
        .get_credentials(&connection, "owner-1", Some("profile-b"))
        .expect_err("profile is authenticated");
    assert!(
        error
            .to_string()
            .contains("Saved upstream credentials cannot be decrypted")
    );
}

#[test]
fn creates_a_private_key_file_when_no_pepper_is_configured() {
    let directory = tempfile::tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let connection = db.connect().expect("connection");
    let store = UpstreamCredentialStore::for_state_db(db.path());
    store
        .save(
            &connection,
            "owner-1",
            &UpstreamCredentials {
                base_url: "https://api.example.com/v1".to_string(),
                provider: "provider-1".to_string(),
                api_key: "secret-key".to_string(),
            },
            None,
        )
        .expect("save");

    let key_path = directory.path().join("upstream-credentials.key");
    assert_eq!(fs::read(&key_path).expect("key").len(), 32);
    assert_private_file(&key_path);
    assert_private_file(&directory.path().join("state.db"));
}

#[test]
fn normalizes_upstream_urls_like_node() {
    let cases = [
        ("api.example.com", "https://api.example.com/v1"),
        ("https://api.example.com/", "https://api.example.com/v1"),
        (
            "https://api.example.com/v1/chat/completions?x=1#fragment",
            "https://api.example.com/v1",
        ),
        ("//api.example.com/models", "https://api.example.com/v1"),
        ("http://localhost:8000", "http://localhost:8000/v1"),
    ];
    for (input, expected) in cases {
        assert_eq!(
            normalize_upstream_base_url(input).expect("normalize"),
            expected,
            "{input}"
        );
    }
    for (input, message) in [
        ("", "Upstream base URL is required"),
        (
            "ftp://example.com",
            "Upstream base URL must use HTTP or HTTPS",
        ),
        (
            "https://user:pass@example.com",
            "Upstream base URL must not contain credentials",
        ),
    ] {
        let error = normalize_upstream_base_url(input).expect_err("invalid");
        assert!(error.to_string().contains(message), "{input}: {error}");
    }
}

#[cfg(unix)]
fn assert_private_file(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(path).expect("metadata").permissions().mode();
    assert_eq!(mode & 0o077, 0, "{} must be private", path.display());
}

#[test]
#[cfg(unix)]
fn typescript_decrypts_a_rust_credential_envelope() {
    let directory = tempfile::tempdir().expect("temp dir");
    let db_path = directory.path().join("state.db");
    let db = StateDb::open(&db_path).expect("state db");
    let connection = db.connect().expect("connection");
    let store = UpstreamCredentialStore::with_pepper("rust-to-typescript-pepper");
    store
        .save(
            &connection,
            "owner-rust",
            &UpstreamCredentials {
                base_url: "https://api.example.com/v1".to_string(),
                provider: "provider-rust".to_string(),
                api_key: "rust-secret".to_string(),
            },
            Some("provider-rust"),
        )
        .expect("save");
    drop(connection);

    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let source_store_path = root.join("ts-server/server/state/upstreamCredentialStore.ts");
    let store_path = if source_store_path.exists() {
        source_store_path
    } else {
        root.join("ts-server/dist/server/state/upstreamCredentialStore.js")
    };
    let script = r#"
import Database from "better-sqlite3";
import { pathToFileURL } from "node:url";
const storeModule = await import(pathToFileURL(process.env.ADS_TS_STORE).href);
const createUpstreamCredentialStore =
  storeModule.createUpstreamCredentialStore ?? storeModule.default?.createUpstreamCredentialStore;
const db = new Database(process.env.ADS_DB_PATH, { readonly: true });
const store = createUpstreamCredentialStore(db, { pepper: process.env.ADS_TEST_PEPPER });
const credentials = store.getCredentials("owner-rust", "provider-rust");
if (!credentials || credentials.apiKey !== "rust-secret" || credentials.baseUrl !== "https://api.example.com/v1") {
  throw new Error(`unexpected credentials: ${JSON.stringify(credentials)}`);
}
console.log("ok");
"#;
    let output = std::process::Command::new("node")
        .args(["--import", "tsx", "--input-type=module", "-e", script])
        .current_dir(&root)
        .env("ADS_DB_PATH", &db_path)
        .env("ADS_TS_STORE", &store_path)
        .env("ADS_TEST_PEPPER", "rust-to-typescript-pepper")
        .output()
        .expect("run node");
    assert!(
        output.status.success(),
        "node failed:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("ok"));
}
