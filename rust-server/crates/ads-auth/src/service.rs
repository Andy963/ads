use std::sync::Mutex;
use std::time::Duration;

use ads_contract::auth::LoginRequest;
use ads_contract::time::now_unix_seconds;
use ads_contract::{DEFAULT_SESSION_TTL_SECONDS, MIN_SESSION_TTL_SECONDS};
use ads_state::{
    NewWebSession, ResetAdminRecord, StateDb, StateError, WebUser, count_users, create_session,
    find_primary_active_user, find_user_by_id, find_user_credential_by_username,
    insert_user_if_empty, lookup_session_by_token_hash, record_login, reset_admin_user,
    revoke_session_by_token_hash, touch_session,
};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::password::verify_password_scrypt;
use crate::rate_limit::{
    DEFAULT_BASE_LOCKOUT, DEFAULT_MAX_ATTEMPTS, LoginRateLimiter, build_login_rate_limit_keys,
};

#[derive(Debug, Clone)]
pub struct AuthConfig {
    pub session_ttl_seconds: i64,
    pub session_pepper: String,
    pub sliding_sessions: bool,
    pub login_max_attempts: u32,
    pub login_base_lockout: Duration,
}

impl AuthConfig {
    pub fn from_env() -> Self {
        Self {
            session_ttl_seconds: parse_env_i64("ADS_WEB_SESSION_TTL_SECONDS")
                .unwrap_or(DEFAULT_SESSION_TTL_SECONDS)
                .max(MIN_SESSION_TTL_SECONDS),
            session_pepper: std::env::var("ADS_WEB_SESSION_PEPPER")
                .unwrap_or_default()
                .trim()
                .to_string(),
            sliding_sessions: parse_env_bool("ADS_WEB_SESSION_SLIDING", false),
            login_max_attempts: parse_env_u32("ADS_WEB_LOGIN_MAX_ATTEMPTS")
                .unwrap_or(DEFAULT_MAX_ATTEMPTS)
                .max(1),
            login_base_lockout: Duration::from_millis(
                parse_env_u64("ADS_WEB_LOGIN_LOCKOUT_MS")
                    .unwrap_or(DEFAULT_BASE_LOCKOUT.as_millis() as u64)
                    .max(1_000),
            ),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct RequestMetadata {
    pub ip: Option<String>,
    pub user_agent: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AuthenticatedSession {
    pub user: WebUser,
    pub token_hash: String,
    pub refresh_expires_at: Option<i64>,
}

#[derive(Debug)]
pub enum LoginOutcome {
    Success {
        token: String,
        expires_at: i64,
        user: WebUser,
    },
    Unauthorized,
    Locked {
        retry_after: Duration,
    },
    InvalidPayload,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InitAdminOutcome {
    Created { user_id: String, username: String },
    AlreadyInitialized,
    InvalidInput(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResetAdminOutcome {
    Created {
        user_id: String,
        username: String,
    },
    Updated {
        user_id: String,
        username: String,
        previous_username: String,
    },
    InvalidInput(&'static str),
}

#[derive(Debug, Error)]
pub enum AuthError {
    #[error(transparent)]
    State(#[from] StateError),
}

pub struct AuthService {
    db: StateDb,
    config: AuthConfig,
    limiter: Mutex<LoginRateLimiter>,
}

impl AuthService {
    pub fn new(db: StateDb, config: AuthConfig) -> Self {
        let limiter = LoginRateLimiter::new(config.login_max_attempts, config.login_base_lockout);
        Self {
            db,
            config,
            limiter: Mutex::new(limiter),
        }
    }

    pub fn db(&self) -> &StateDb {
        &self.db
    }

    pub fn status(&self) -> Result<bool, AuthError> {
        Ok(count_users(&self.db)? > 0)
    }

    pub fn init_admin(
        &self,
        username: &str,
        password: &str,
    ) -> Result<InitAdminOutcome, AuthError> {
        let username = username.trim();
        if username.is_empty() {
            return Ok(InitAdminOutcome::InvalidInput("username is required"));
        }
        if password.is_empty() {
            return Ok(InitAdminOutcome::InvalidInput("password is required"));
        }
        if count_users(&self.db)? > 0 {
            return Ok(InitAdminOutcome::AlreadyInitialized);
        }

        let user_id = Uuid::new_v4().to_string();
        let password_hash = crate::hash_password_scrypt(password);
        let created = insert_user_if_empty(
            &self.db,
            &user_id,
            username,
            &password_hash,
            now_unix_seconds(),
        )?;
        if !created {
            return Ok(InitAdminOutcome::AlreadyInitialized);
        }
        Ok(InitAdminOutcome::Created {
            user_id,
            username: username.to_string(),
        })
    }

    pub fn reset_admin(
        &self,
        username: &str,
        password: &str,
    ) -> Result<ResetAdminOutcome, AuthError> {
        self.reset_admin_at(username, password, now_unix_seconds())
    }

    pub fn reset_admin_at(
        &self,
        username: &str,
        password: &str,
        now_seconds: i64,
    ) -> Result<ResetAdminOutcome, AuthError> {
        let username = username.trim();
        if username.is_empty() {
            return Ok(ResetAdminOutcome::InvalidInput("username is required"));
        }
        if password.is_empty() {
            return Ok(ResetAdminOutcome::InvalidInput("password is required"));
        }

        let password_hash = crate::hash_password_scrypt(password);
        let new_user_id = Uuid::new_v4().to_string();
        match reset_admin_user(
            &self.db,
            &new_user_id,
            username,
            &password_hash,
            now_seconds,
        )? {
            ResetAdminRecord::Created { user_id } => Ok(ResetAdminOutcome::Created {
                user_id,
                username: username.to_string(),
            }),
            ResetAdminRecord::Updated {
                user_id,
                previous_username,
            } => Ok(ResetAdminOutcome::Updated {
                user_id,
                username: username.to_string(),
                previous_username,
            }),
        }
    }

    pub fn login(
        &self,
        request: &LoginRequest,
        metadata: &RequestMetadata,
    ) -> Result<LoginOutcome, AuthError> {
        self.login_at(request, metadata, now_unix_seconds())
    }

    pub fn login_at(
        &self,
        request: &LoginRequest,
        metadata: &RequestMetadata,
        now_seconds: i64,
    ) -> Result<LoginOutcome, AuthError> {
        if !request.is_valid() {
            return Ok(LoginOutcome::InvalidPayload);
        }

        let username = request.username.trim();
        let keys = build_login_rate_limit_keys(username, metadata.ip.as_deref());
        let lock_state = self
            .limiter
            .lock()
            .expect("login limiter lock")
            .check(&keys);
        if lock_state.locked {
            return Ok(LoginOutcome::Locked {
                retry_after: lock_state.retry_after,
            });
        }

        let credential = find_user_credential_by_username(&self.db, username)?;
        let valid = credential.as_ref().is_some_and(|credential| {
            credential.user.disabled_at.is_none()
                && verify_password_scrypt(&request.password, &credential.password_hash)
        });
        if !valid {
            self.limiter
                .lock()
                .expect("login limiter lock")
                .record_failure(&keys);
            return Ok(LoginOutcome::Unauthorized);
        }
        self.limiter
            .lock()
            .expect("login limiter lock")
            .record_success(&keys);

        let credential = credential.expect("validated credential is present");
        let token = generate_session_token();
        let token_hash = hash_session_token(&token, &self.config.session_pepper);
        let session_id = Uuid::new_v4().to_string();
        let expires_at = now_seconds + self.config.session_ttl_seconds;
        create_session(
            &self.db,
            NewWebSession {
                id: &session_id,
                user_id: &credential.user.id,
                token_hash: &token_hash,
                created_at: now_seconds,
                expires_at,
                last_seen_ip: metadata.ip.as_deref(),
                user_agent: metadata.user_agent.as_deref(),
            },
        )?;
        record_login(&self.db, &credential.user.id, now_seconds)?;

        Ok(LoginOutcome::Success {
            token,
            expires_at,
            user: credential.user,
        })
    }

    pub fn authenticate_connector(
        &self,
        authorization: Option<&str>,
    ) -> Result<Option<AuthenticatedSession>, AuthError> {
        let connector_token = std::env::var("ADS_CONNECTOR_TOKEN")
            .unwrap_or_default()
            .trim()
            .to_string();
        if connector_token.is_empty() {
            return Ok(None);
        }
        let Some(bearer_token) = parse_bearer_token(authorization) else {
            return Ok(None);
        };
        if bearer_token != connector_token {
            return Ok(None);
        }

        let configured_user_id = std::env::var("ADS_CONNECTOR_USER_ID")
            .unwrap_or_default()
            .trim()
            .to_string();
        let (user_id, username) =
            if !configured_user_id.is_empty() && configured_user_id != "connector" {
                (configured_user_id.clone(), configured_user_id)
            } else {
                match find_primary_active_user(&self.db) {
                    Ok(Some(user)) => (user.id, user.username),
                    _ => {
                        let fallback = if configured_user_id.is_empty() {
                            "connector".to_string()
                        } else {
                            configured_user_id
                        };
                        (fallback.clone(), fallback)
                    }
                }
            };

        Ok(Some(AuthenticatedSession {
            user: WebUser {
                id: user_id,
                username,
                created_at: 0,
                updated_at: 0,
                last_login_at: None,
                disabled_at: None,
            },
            token_hash: hash_session_token(&bearer_token, &self.config.session_pepper),
            refresh_expires_at: None,
        }))
    }

    pub fn authenticate(
        &self,
        token: &str,
        metadata: &RequestMetadata,
    ) -> Result<Option<AuthenticatedSession>, AuthError> {
        self.authenticate_at(token, metadata, now_unix_seconds())
    }

    pub fn authenticate_at(
        &self,
        token: &str,
        metadata: &RequestMetadata,
        now_seconds: i64,
    ) -> Result<Option<AuthenticatedSession>, AuthError> {
        let token = token.trim();
        if token.is_empty() {
            return Ok(None);
        }

        let token_hash = hash_session_token(token, &self.config.session_pepper);
        let Some(session) = lookup_session_by_token_hash(&self.db, &token_hash)? else {
            return Ok(None);
        };
        if session.revoked_at.is_some() || session.expires_at <= now_seconds {
            return Ok(None);
        }
        let Some(user) = find_user_by_id(&self.db, &session.user_id)? else {
            return Ok(None);
        };

        let refresh_expires_at = if self.config.sliding_sessions
            && session.expires_at - now_seconds < self.config.session_ttl_seconds / 2
        {
            Some(now_seconds + self.config.session_ttl_seconds)
        } else {
            None
        };
        touch_session(
            &self.db,
            &session.token_hash,
            now_seconds,
            metadata.ip.as_deref(),
            metadata.user_agent.as_deref(),
            refresh_expires_at,
        )?;

        Ok(Some(AuthenticatedSession {
            user,
            token_hash,
            refresh_expires_at,
        }))
    }

    pub fn logout(&self, token: &str) -> Result<bool, AuthError> {
        self.logout_at(token, now_unix_seconds())
    }

    pub fn logout_at(&self, token: &str, now_seconds: i64) -> Result<bool, AuthError> {
        let token = token.trim();
        if token.is_empty() {
            return Ok(false);
        }
        let token_hash = hash_session_token(token, &self.config.session_pepper);
        Ok(revoke_session_by_token_hash(
            &self.db,
            &token_hash,
            now_seconds,
        )?)
    }

    pub fn session_ttl_seconds(&self) -> i64 {
        self.config.session_ttl_seconds
    }
}

fn parse_bearer_token(authorization: Option<&str>) -> Option<String> {
    let raw = authorization?.trim();
    let (scheme, token) = raw.split_once(char::is_whitespace)?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    (!token.is_empty()).then(|| token.to_string())
}

pub fn hash_session_token(token: &str, pepper: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    if !pepper.is_empty() {
        hasher.update(b":");
        hasher.update(pepper.as_bytes());
    }
    hex::encode(hasher.finalize())
}

fn generate_session_token() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn parse_env_i64(name: &str) -> Option<i64> {
    std::env::var(name).ok()?.trim().parse().ok()
}

fn parse_env_u64(name: &str) -> Option<u64> {
    std::env::var(name).ok()?.trim().parse().ok()
}

fn parse_env_u32(name: &str) -> Option<u32> {
    std::env::var(name).ok()?.trim().parse().ok()
}

fn parse_env_bool(name: &str, default: bool) -> bool {
    let Ok(raw) = std::env::var(name) else {
        return default;
    };
    match raw.trim().to_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => default,
    }
}

#[cfg(test)]
mod tests {
    use super::parse_bearer_token;

    #[test]
    fn parses_bearer_tokens_like_node() {
        assert_eq!(
            parse_bearer_token(Some("Bearer connector-secret")).as_deref(),
            Some("connector-secret")
        );
        assert_eq!(
            parse_bearer_token(Some("bearer\ttoken")).as_deref(),
            Some("token")
        );
        assert_eq!(parse_bearer_token(Some("Basic abc")), None);
        assert_eq!(parse_bearer_token(Some("Bearer   ")), None);
        assert_eq!(parse_bearer_token(None), None);
    }
}
