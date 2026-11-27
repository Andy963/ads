use std::fs::{self, DirBuilder, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use hkdf::Hkdf;
use rand::RngCore;
use rand::rngs::OsRng;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use url::Url;

use crate::{StateError, StateResult, resolve_ads_state_dir};

const NAMESPACE: &str = "web_upstream_credentials";
const KEY_INFO: &[u8] = b"ads:upstream-credentials:v1";
const MAX_KEY_BYTES: usize = 16_384;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpstreamCredentials {
    pub base_url: String,
    pub provider: String,
    pub api_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpstreamCredentialMetadata {
    pub base_url: String,
    pub provider: String,
    pub has_api_key: bool,
}

#[derive(Clone)]
pub struct UpstreamCredentialStore {
    db_path: Option<PathBuf>,
    key_file: Option<PathBuf>,
    pepper: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialEnvelope {
    version: u8,
    base_url: String,
    provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    profile: Option<String>,
    iv: String,
    tag: String,
    ciphertext: String,
}

impl UpstreamCredentialStore {
    pub fn for_state_db(db_path: impl AsRef<Path>) -> Self {
        let db_path = db_path.as_ref().to_path_buf();
        let pepper = std::env::var("ADS_WEB_SESSION_PEPPER")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let key_file = pepper.is_none().then(|| {
            db_path
                .parent()
                .map_or_else(resolve_ads_state_dir, Path::to_path_buf)
                .join("upstream-credentials.key")
        });
        Self {
            db_path: Some(db_path),
            key_file,
            pepper,
        }
    }

    pub fn with_pepper(pepper: impl Into<String>) -> Self {
        Self {
            db_path: None,
            key_file: None,
            pepper: Some(pepper.into()),
        }
    }

    pub fn with_key_file(key_file: impl Into<PathBuf>) -> Self {
        Self {
            db_path: None,
            key_file: Some(key_file.into()),
            pepper: None,
        }
    }

    pub fn get_metadata(
        &self,
        connection: &rusqlite::Connection,
        owner: &str,
        profile: Option<&str>,
    ) -> StateResult<Option<UpstreamCredentialMetadata>> {
        let value = self.read_envelope(connection, owner, profile)?;
        Ok(value.map(|value| UpstreamCredentialMetadata {
            base_url: value.base_url,
            provider: value.provider,
            has_api_key: true,
        }))
    }

    pub fn get_credentials(
        &self,
        connection: &rusqlite::Connection,
        owner: &str,
        profile: Option<&str>,
    ) -> StateResult<Option<UpstreamCredentials>> {
        let normalized_profile = profile_key(profile)?;
        let Some(value) = self.read_envelope(connection, owner, Some(&normalized_profile))? else {
            return Ok(None);
        };
        if value.profile.as_deref().unwrap_or("") != normalized_profile {
            return Err(decryption_error());
        }

        let (iv, tag, ciphertext) = decode_ciphertext(&value)?;
        let mut sealed = ciphertext;
        sealed.extend_from_slice(&tag);
        let key = self.encryption_key()?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| decryption_error())?;
        let aad = build_aad(owner, &normalized_profile, &value.base_url, &value.provider);
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(&iv),
                Payload {
                    msg: &sealed,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| decryption_error())?;
        let api_key = String::from_utf8(plaintext).map_err(|_| decryption_error())?;
        Ok(Some(UpstreamCredentials {
            base_url: value.base_url,
            provider: value.provider,
            api_key,
        }))
    }

    pub fn save(
        &self,
        connection: &rusqlite::Connection,
        owner: &str,
        credentials: &UpstreamCredentials,
        profile: Option<&str>,
    ) -> StateResult<()> {
        let normalized_profile = profile_key(profile)?;
        require_owner(owner)?;
        let base_url = normalize_upstream_base_url(&credentials.base_url)?;
        let provider = credentials.provider.trim();
        let provider = if provider.is_empty() {
            "openai".to_string()
        } else {
            provider.to_string()
        };
        if utf16_len(&provider) > 128 {
            return Err(StateError::InvalidInput(
                "Invalid upstream credentials".to_string(),
            ));
        }
        let api_key = credentials.api_key.trim();
        if api_key.is_empty() || api_key.len() > MAX_KEY_BYTES {
            return Err(StateError::InvalidInput(
                "Invalid upstream credentials".to_string(),
            ));
        }

        let mut iv = [0_u8; 12];
        OsRng.fill_bytes(&mut iv);
        let key = self.encryption_key()?;
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| StateError::InvalidInput("Invalid upstream credentials".to_string()))?;
        let aad = build_aad(owner, &normalized_profile, &base_url, &provider);
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&iv),
                Payload {
                    msg: api_key.as_bytes(),
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| StateError::InvalidInput("Invalid upstream credentials".to_string()))?;
        let (payload, encrypted) = ciphertext.split_at(ciphertext.len() - 16);

        let record_key = record_key(owner, &normalized_profile);
        let envelope = CredentialEnvelope {
            version: 1,
            base_url,
            provider,
            profile: (!normalized_profile.is_empty()).then(|| normalized_profile.clone()),
            iv: STANDARD.encode(iv),
            tag: STANDARD.encode(encrypted),
            ciphertext: STANDARD.encode(payload),
        };
        let value = serde_json::to_string(&envelope).map_err(|error| {
            StateError::InvalidInput(format!("Invalid upstream credentials: {error}"))
        })?;

        self.restrict_database_permissions()?;
        connection.execute(
            "INSERT INTO kv_state (namespace, key, value, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(namespace, key) DO UPDATE SET
               value = excluded.value,
               updated_at = excluded.updated_at",
            params![NAMESPACE, record_key, value, now_millis()],
        )?;
        Ok(())
    }

    pub fn delete(
        &self,
        connection: &rusqlite::Connection,
        owner: &str,
        profile: Option<&str>,
    ) -> StateResult<bool> {
        let normalized_profile = profile_key(profile)?;
        require_owner(owner)?;
        let deleted = connection.execute(
            "DELETE FROM kv_state WHERE namespace = ?1 AND key = ?2",
            params![NAMESPACE, record_key(owner, &normalized_profile)],
        )?;
        Ok(deleted > 0)
    }

    fn read_envelope(
        &self,
        connection: &rusqlite::Connection,
        owner: &str,
        profile: Option<&str>,
    ) -> StateResult<Option<CredentialEnvelope>> {
        let normalized_profile = profile_key(profile)?;
        require_owner(owner)?;
        let value: Option<String> = connection
            .query_row(
                "SELECT value FROM kv_state WHERE namespace = ?1 AND key = ?2",
                params![NAMESPACE, record_key(owner, &normalized_profile)],
                |row| row.get(0),
            )
            .optional()?;
        let Some(value) = value else {
            return Ok(None);
        };
        let envelope: CredentialEnvelope =
            serde_json::from_str(&value).map_err(|_| invalid_configuration_error())?;
        validate_envelope(&envelope)?;
        Ok(Some(envelope))
    }

    fn encryption_key(&self) -> StateResult<[u8; 32]> {
        if let Some(pepper) = self
            .pepper
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let hkdf = Hkdf::<Sha256>::new(None, pepper.as_bytes());
            let mut key = [0_u8; 32];
            hkdf.expand(KEY_INFO, &mut key).map_err(|_| {
                StateError::InvalidInput("Invalid upstream encryption key".to_string())
            })?;
            return Ok(key);
        }

        let key_file = self.key_file.as_deref().ok_or_else(|| {
            StateError::InvalidInput("Upstream encryption key is not configured".to_string())
        })?;
        read_private_key(key_file)
    }

    fn restrict_database_permissions(&self) -> StateResult<()> {
        let Some(db_path) = self.db_path.as_deref() else {
            return Ok(());
        };
        for suffix in ["", "-wal", "-shm"] {
            let path = PathBuf::from(format!("{}{suffix}", db_path.to_string_lossy()));
            match fs::set_permissions(&path, private_file_permissions()) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(StateError::Io(error)),
            }
        }
        Ok(())
    }
}

pub fn normalize_upstream_base_url(input: &str) -> StateResult<String> {
    let value = input.trim();
    if value.is_empty() {
        return Err(StateError::InvalidInput(
            "Upstream base URL is required".to_string(),
        ));
    }
    let candidate = if value.starts_with("//") {
        format!("https:{value}")
    } else if value.contains("://") {
        value.to_string()
    } else {
        format!("https://{value}")
    };
    let mut url = Url::parse(&candidate)
        .map_err(|_| StateError::InvalidInput("Invalid upstream base URL".to_string()))?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err(StateError::InvalidInput(
            "Upstream base URL must use HTTP or HTTPS".to_string(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(StateError::InvalidInput(
            "Upstream base URL must not contain credentials".to_string(),
        ));
    }

    let mut pathname = url.path().trim_end_matches('/').to_string();
    for suffix in ["/responses", "/chat/completions", "/completions", "/models"] {
        if pathname.ends_with(suffix) {
            pathname.truncate(pathname.len() - suffix.len());
            break;
        }
    }
    if pathname.is_empty() {
        pathname = "/v1".to_string();
    }
    url.set_path(&pathname);
    url.set_query(None);
    url.set_fragment(None);
    let normalized = url.to_string();
    if utf16_len(&normalized) > 2048 {
        return Err(StateError::InvalidInput(
            "Upstream base URL is too long".to_string(),
        ));
    }
    Ok(normalized)
}

fn profile_key(profile: Option<&str>) -> StateResult<String> {
    let normalized = profile.unwrap_or("").trim().to_string();
    if utf16_len(&normalized) > 128 {
        return Err(StateError::InvalidInput(
            "Credential profile is too long".to_string(),
        ));
    }
    if !normalized.is_empty() {
        let mut chars = normalized.chars();
        let valid_first = chars
            .next()
            .is_some_and(|value| value.is_ascii_alphanumeric());
        if !valid_first
            || !normalized
                .chars()
                .all(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '_' | '-'))
        {
            return Err(StateError::InvalidInput(
                "Credential profile must contain only letters, numbers, dots, underscores, and hyphens"
                    .to_string(),
            ));
        }
    }
    Ok(normalized)
}

fn require_owner(owner: &str) -> StateResult<()> {
    if owner.trim().is_empty() {
        return Err(StateError::InvalidInput(
            "An authenticated owner is required".to_string(),
        ));
    }
    Ok(())
}

fn record_key(owner: &str, profile: &str) -> String {
    if profile.is_empty() {
        owner.to_string()
    } else {
        format!("{owner}\0profile:{profile}")
    }
}

fn build_aad(owner: &str, profile: &str, base_url: &str, provider: &str) -> String {
    if profile.is_empty() {
        serde_json::json!([NAMESPACE, owner, base_url, provider]).to_string()
    } else {
        serde_json::json!([NAMESPACE, owner, profile, base_url, provider]).to_string()
    }
}

fn validate_envelope(value: &CredentialEnvelope) -> StateResult<()> {
    let valid = value.version == 1
        && (1..=2048).contains(&utf16_len(&value.base_url))
        && (1..=128).contains(&utf16_len(&value.provider))
        && value
            .profile
            .as_deref()
            .is_none_or(|profile| utf16_len(profile) <= 128)
        && utf16_len(&value.iv) <= 32
        && utf16_len(&value.tag) <= 32
        && (1..=32_768).contains(&utf16_len(&value.ciphertext));
    if !valid {
        return Err(invalid_configuration_error());
    }
    Ok(())
}

fn decode_ciphertext(value: &CredentialEnvelope) -> StateResult<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    let iv = STANDARD.decode(&value.iv).map_err(|_| decryption_error())?;
    let tag = STANDARD
        .decode(&value.tag)
        .map_err(|_| decryption_error())?;
    let ciphertext = STANDARD
        .decode(&value.ciphertext)
        .map_err(|_| decryption_error())?;
    if iv.len() != 12 || tag.len() != 16 || ciphertext.is_empty() {
        return Err(decryption_error());
    }
    Ok((iv, tag, ciphertext))
}

fn read_private_key(filename: &Path) -> StateResult<[u8; 32]> {
    if let Some(parent) = filename.parent() {
        let mut builder = DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(parent)?;
    }

    let mut create = OpenOptions::new();
    create.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        create.mode(0o600);
    }
    match create.open(filename) {
        Ok(mut file) => {
            let mut key = [0_u8; 32];
            OsRng.fill_bytes(&mut key);
            std::io::Write::write_all(&mut file, &key)?;
            return Ok(key);
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(StateError::Io(error)),
    }

    let mut open = OpenOptions::new();
    open.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = open.open(filename)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.mode() & 0o077 != 0 {
            return Err(StateError::InvalidInput(
                "Upstream encryption key must be a private file".to_string(),
            ));
        }
    }
    let mut key = Vec::new();
    file.read_to_end(&mut key)?;
    if key.len() != 32 {
        return Err(StateError::InvalidInput(
            "Invalid upstream encryption key".to_string(),
        ));
    }
    key.try_into()
        .map_err(|_| StateError::InvalidInput("Invalid upstream encryption key".to_string()))
}

fn private_file_permissions() -> fs::Permissions {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::Permissions::from_mode(0o600)
    }
    #[cfg(not(unix))]
    {
        fs::Permissions::readonly()
    }
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

fn invalid_configuration_error() -> StateError {
    StateError::InvalidInput(
        "Saved upstream configuration is invalid; re-enter the endpoint and API key".to_string(),
    )
}

fn decryption_error() -> StateError {
    StateError::InvalidInput(
        "Saved upstream credentials cannot be decrypted; re-enter the API key".to_string(),
    )
}
