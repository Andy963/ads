use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ads_state::{
    StateDb, StateError, StoredWebPushSubscription, list_web_push_subscriptions_by_user,
    remove_web_push_subscription, save_web_push_subscription,
};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use futures_util::future::join_all;
use hkdf::Hkdf;
use ring::agreement::{self, EphemeralPrivateKey, UnparsedPublicKey};
use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair};
use serde::Serialize;
use serde_json::json;
use sha2::Sha256;
use url::Url;

const DEFAULT_RECORD_SIZE: u32 = 4096;
const VAPID_TTL_SECS: i64 = 12 * 60 * 60;
const PUSH_TTL_HEADER: &str = "60";
const PUSH_URGENCY_HEADER: &str = "low";
const PUSH_HTTP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Default)]
pub struct WebPushConfig {
    pub public_key: Option<String>,
    pub private_key: Option<String>,
    pub subject: Option<String>,
}

impl WebPushConfig {
    pub fn from_env() -> Self {
        Self {
            public_key: std::env::var("ADS_WEB_PUSH_PUBLIC_KEY").ok(),
            private_key: std::env::var("ADS_WEB_PUSH_PRIVATE_KEY").ok(),
            subject: std::env::var("ADS_WEB_PUSH_SUBJECT").ok(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WebPushNotificationType {
    AssistantResponse,
    PromptError,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebPushNotification {
    pub kind: WebPushNotificationType,
    pub lane: Option<String>,
    pub project: Option<String>,
    pub session_id: Option<String>,
}

impl WebPushNotification {
    pub fn payload_json(&self) -> String {
        let mut object = serde_json::Map::new();
        object.insert(
            "type".to_string(),
            serde_json::to_value(self.kind).expect("serialize notification type"),
        );
        if let Some(lane) = self
            .lane
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            object.insert("lane".to_string(), json!(lane));
        }
        if let Some(project) = self
            .project
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            object.insert("project".to_string(), json!(project));
        }
        if let Some(session_id) = self
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            object.insert("sessionId".to_string(), json!(session_id));
        }
        serde_json::Value::Object(object).to_string()
    }
}

#[derive(Debug, Clone)]
pub struct WebPushHttpRequest {
    pub endpoint: String,
    pub authorization: String,
    pub body: Vec<u8>,
    pub ttl: &'static str,
    pub urgency: &'static str,
}

pub type WebPushFuture<'a> = Pin<Box<dyn Future<Output = Result<u16, String>> + Send + 'a>>;

pub trait WebPushTransport: Send + Sync {
    fn send<'a>(&'a self, request: WebPushHttpRequest) -> WebPushFuture<'a>;
}

pub struct ReqwestWebPushTransport {
    client: reqwest::Client,
}

impl ReqwestWebPushTransport {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(PUSH_HTTP_TIMEOUT)
            .build()
            .expect("build web push http client");
        Self { client }
    }
}

impl Default for ReqwestWebPushTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl WebPushTransport for ReqwestWebPushTransport {
    fn send<'a>(&'a self, request: WebPushHttpRequest) -> WebPushFuture<'a> {
        Box::pin(async move {
            let response = self
                .client
                .post(&request.endpoint)
                .header("Authorization", request.authorization)
                .header("Content-Encoding", "aes128gcm")
                .header("Content-Type", "application/octet-stream")
                .header("TTL", request.ttl)
                .header("Urgency", request.urgency)
                .body(request.body)
                .send()
                .await
                .map_err(|error| error.to_string())?;
            Ok(response.status().as_u16())
        })
    }
}

struct VapidSigner {
    public_key_b64: String,
    subject: String,
    key_pair: EcdsaKeyPair,
}

impl VapidSigner {
    fn from_config(config: &WebPushConfig) -> Result<Option<Self>, String> {
        let public_key_b64 = config.public_key.as_deref().unwrap_or("").trim();
        let private_key_b64 = config.private_key.as_deref().unwrap_or("").trim();
        let subject = config.subject.as_deref().unwrap_or("").trim();
        if public_key_b64.is_empty() && private_key_b64.is_empty() && subject.is_empty() {
            return Ok(None);
        }
        if public_key_b64.is_empty() || private_key_b64.is_empty() || subject.is_empty() {
            return Err("incomplete VAPID configuration".to_string());
        }
        if !subject.starts_with("mailto:") && !subject.starts_with("https://") {
            return Err("VAPID subject must start with mailto: or https://".to_string());
        }
        let public_bytes = decode_base64url(public_key_b64)
            .ok_or_else(|| "invalid VAPID public key encoding".to_string())?;
        if public_bytes.len() != 65 || public_bytes[0] != 0x04 {
            return Err("VAPID public key must be a 65-byte uncompressed P-256 point".to_string());
        }
        let private_bytes = decode_base64url(private_key_b64)
            .ok_or_else(|| "invalid VAPID private key encoding".to_string())?;
        if private_bytes.len() != 32 {
            return Err("VAPID private key must be 32 bytes".to_string());
        }
        let rng = SystemRandom::new();
        let key_pair = EcdsaKeyPair::from_private_key_and_public_key(
            &ECDSA_P256_SHA256_FIXED_SIGNING,
            &private_bytes,
            &public_bytes,
            &rng,
        )
        .map_err(|_| "VAPID key pair validation failed".to_string())?;
        Ok(Some(Self {
            public_key_b64: public_key_b64.to_string(),
            subject: subject.to_string(),
            key_pair,
        }))
    }

    fn authorization_header(&self, endpoint: &str, now_unix_secs: i64) -> Result<String, String> {
        let url = Url::parse(endpoint).map_err(|_| "invalid push endpoint URL".to_string())?;
        let origin = url.origin().ascii_serialization();
        if origin == "null" {
            return Err("push endpoint has opaque origin".to_string());
        }
        let header_json = json!({ "typ": "JWT", "alg": "ES256" }).to_string();
        let claims_json = json!({
            "aud": origin,
            "exp": now_unix_secs.saturating_add(VAPID_TTL_SECS),
            "sub": self.subject,
        })
        .to_string();
        let signing_input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header_json.as_bytes()),
            URL_SAFE_NO_PAD.encode(claims_json.as_bytes()),
        );
        let rng = SystemRandom::new();
        let signature = self
            .key_pair
            .sign(&rng, signing_input.as_bytes())
            .map_err(|_| "failed to sign VAPID JWT".to_string())?;
        let jwt = format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        );
        Ok(format!("vapid t={jwt}, k={}", self.public_key_b64))
    }
}

pub struct WebPushService {
    db: StateDb,
    signer: Option<VapidSigner>,
    transport: Arc<dyn WebPushTransport>,
}

impl WebPushService {
    pub fn new(db: StateDb, config: WebPushConfig) -> Self {
        Self::with_transport(db, config, Arc::new(ReqwestWebPushTransport::new()))
    }

    pub fn with_transport(
        db: StateDb,
        config: WebPushConfig,
        transport: Arc<dyn WebPushTransport>,
    ) -> Self {
        let signer = match VapidSigner::from_config(&config) {
            Ok(signer) => signer,
            Err(_) => {
                eprintln!("[WebPush] Invalid VAPID configuration; notifications are disabled");
                None
            }
        };
        Self {
            db,
            signer,
            transport,
        }
    }

    pub fn is_configured(&self) -> bool {
        self.signer.is_some()
    }

    pub fn public_key(&self) -> Option<&str> {
        self.signer.as_ref().map(|s| s.public_key_b64.as_str())
    }

    pub fn save_subscription(
        &self,
        user_id: &str,
        subscription: &StoredWebPushSubscription,
    ) -> Result<(), StateError> {
        let mut connection = self.db.connect()?;
        save_web_push_subscription(&mut connection, user_id, subscription, now_unix_secs())
    }

    pub fn remove_subscription(&self, user_id: &str, endpoint: &str) -> Result<(), StateError> {
        let connection = self.db.connect()?;
        remove_web_push_subscription(&connection, user_id, endpoint)
    }

    pub async fn notify_user(&self, user_id: &str, notification: WebPushNotification) {
        let Some(signer) = self.signer.as_ref() else {
            return;
        };
        let subscriptions = match self
            .db
            .connect()
            .and_then(|conn| list_web_push_subscriptions_by_user(&conn, user_id))
        {
            Ok(items) => items,
            Err(error) => {
                eprintln!("[WebPush] Failed to read subscriptions: {error}");
                return;
            }
        };
        if subscriptions.is_empty() {
            return;
        }
        let payload = notification.payload_json();
        let now_secs = now_unix_secs();

        let deliveries = subscriptions.into_iter().map(|subscription| {
            let payload_bytes = payload.as_bytes();
            let endpoint_host = Url::parse(&subscription.endpoint)
                .ok()
                .and_then(|u| u.host_str().map(str::to_string))
                .unwrap_or_else(|| "unknown".to_string());
            async move {
                if !is_allowed_web_push_endpoint(&subscription.endpoint) {
                    let _ = self.remove_subscription(user_id, &subscription.endpoint);
                    return;
                }
                let prepared = prepare_delivery(signer, &subscription, payload_bytes, now_secs);
                let request = match prepared {
                    Ok(request) => request,
                    Err(_) => {
                        let _ = self.remove_subscription(user_id, &subscription.endpoint);
                        eprintln!(
                            "[WebPush] Delivery skipped invalid subscription endpoint={endpoint_host}"
                        );
                        return;
                    }
                };
                match self.transport.send(request).await {
                    Ok(status) if (200..300).contains(&status) => {}
                    Ok(status) => {
                        if matches!(status, 400 | 401 | 403 | 404 | 410) {
                            let _ = self.remove_subscription(user_id, &subscription.endpoint);
                        }
                        eprintln!(
                            "[WebPush] Delivery failed endpoint={endpoint_host} status={status}"
                        );
                    }
                    Err(_) => {
                        eprintln!(
                            "[WebPush] Delivery failed endpoint={endpoint_host} status=unknown"
                        );
                    }
                }
            }
        });
        join_all(deliveries).await;
    }
}

fn prepare_delivery(
    signer: &VapidSigner,
    subscription: &StoredWebPushSubscription,
    plaintext: &[u8],
    now_secs: i64,
) -> Result<WebPushHttpRequest, String> {
    let ua_public =
        decode_base64url(&subscription.p256dh).ok_or_else(|| "invalid p256dh key".to_string())?;
    let auth_secret =
        decode_base64url(&subscription.auth).ok_or_else(|| "invalid auth secret".to_string())?;
    let body = encrypt_web_push_payload(&ua_public, &auth_secret, plaintext)?;
    let authorization = signer.authorization_header(&subscription.endpoint, now_secs)?;
    Ok(WebPushHttpRequest {
        endpoint: subscription.endpoint.clone(),
        authorization,
        body,
        ttl: PUSH_TTL_HEADER,
        urgency: PUSH_URGENCY_HEADER,
    })
}

pub fn is_allowed_web_push_endpoint(endpoint: &str) -> bool {
    let Ok(url) = Url::parse(endpoint) else {
        return false;
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    matches!(
        host.as_str(),
        "web.push.apple.com"
            | "fcm.googleapis.com"
            | "updates.push.services.mozilla.com"
            | "push.services.mozilla.com"
    ) || (host.ends_with(".notify.windows.com") && host.len() > ".notify.windows.com".len())
}

pub fn validate_subscription_keys(p256dh: &str, auth: &str) -> bool {
    let is_b64url = |value: &str| {
        value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    };
    if !(40..=128).contains(&p256dh.len()) || !is_b64url(p256dh) {
        return false;
    }
    if !(16..=64).contains(&auth.len()) || !is_b64url(auth) {
        return false;
    }
    let Some(p256dh_bytes) = decode_base64url(p256dh) else {
        return false;
    };
    let Some(auth_bytes) = decode_base64url(auth) else {
        return false;
    };
    p256dh_bytes.len() == 65 && p256dh_bytes[0] == 0x04 && auth_bytes.len() == 16
}

pub fn encrypt_web_push_payload(
    ua_public: &[u8],
    auth_secret: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    if ua_public.len() != 65 || ua_public[0] != 0x04 {
        return Err(
            "subscriber p256dh must be a 65-byte uncompressed P-256 public key".to_string(),
        );
    }
    if auth_secret.len() != 16 {
        return Err("subscriber auth secret must be 16 bytes".to_string());
    }
    let rng = SystemRandom::new();
    let as_private = EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng)
        .map_err(|_| "failed to generate ephemeral P-256 key".to_string())?;
    let as_public = as_private
        .compute_public_key()
        .map_err(|_| "failed to compute ephemeral P-256 public key".to_string())?;
    let mut salt = [0u8; 16];
    rng.fill(&mut salt)
        .map_err(|_| "failed to generate random salt".to_string())?;

    let peer_public = UnparsedPublicKey::new(&agreement::ECDH_P256, ua_public);
    agreement::agree_ephemeral(as_private, &peer_public, |shared_secret| {
        encrypt_aes128gcm_with_secret(
            shared_secret,
            ua_public,
            as_public.as_ref(),
            auth_secret,
            &salt,
            plaintext,
            DEFAULT_RECORD_SIZE,
        )
    })
    .map_err(|_| "ECDH key agreement failed".to_string())?
}

fn encrypt_aes128gcm_with_secret(
    ecdh_secret: &[u8],
    ua_public: &[u8],
    as_public: &[u8],
    auth_secret: &[u8],
    salt: &[u8; 16],
    plaintext: &[u8],
    record_size: u32,
) -> Result<Vec<u8>, String> {
    if ua_public.len() != 65 || as_public.len() != 65 {
        return Err("P-256 public keys must be 65 bytes".to_string());
    }
    // RFC 8291 §3.3: IKM = HKDF(salt=auth_secret, ikm=ecdh_secret, info="WebPush: info\0" || ua_public || as_public, L=32)
    let hkdf_key = Hkdf::<Sha256>::new(Some(auth_secret), ecdh_secret);
    let mut key_info = Vec::with_capacity(14 + 65 + 65);
    key_info.extend_from_slice(b"WebPush: info\0");
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(as_public);
    let mut ikm = [0u8; 32];
    hkdf_key
        .expand(&key_info, &mut ikm)
        .map_err(|_| "HKDF expand IKM failed".to_string())?;

    // RFC 8291 §3.4 / RFC 8188 §2.2-2.3: derive CEK (16B) and NONCE (12B)
    let hkdf_content = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut cek = [0u8; 16];
    hkdf_content
        .expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .map_err(|_| "HKDF expand CEK failed".to_string())?;
    let mut nonce_bytes = [0u8; 12];
    hkdf_content
        .expand(b"Content-Encoding: nonce\0", &mut nonce_bytes)
        .map_err(|_| "HKDF expand nonce failed".to_string())?;

    // RFC 8188 §2: append final-record delimiter 0x02
    let mut padded = Vec::with_capacity(plaintext.len() + 1);
    padded.extend_from_slice(plaintext);
    padded.push(0x02);

    let cipher =
        Aes128Gcm::new_from_slice(&cek).map_err(|_| "AES-128-GCM key error".to_string())?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), padded.as_slice())
        .map_err(|_| "AES-128-GCM encryption failed".to_string())?;

    // RFC 8188 §2.1 header: salt (16) || rs (4 BE) || idlen (1) || keyid (65) || ciphertext
    let mut body = Vec::with_capacity(16 + 4 + 1 + 65 + ciphertext.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&record_size.to_be_bytes());
    body.push(as_public.len() as u8);
    body.extend_from_slice(as_public);
    body.extend_from_slice(&ciphertext);
    Ok(body)
}

fn decode_base64url(value: &str) -> Option<Vec<u8>> {
    let trimmed = value.trim().trim_end_matches('=');
    URL_SAFE_NO_PAD.decode(trimmed).ok()
}

fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{ECDSA_P256_SHA256_FIXED, KeyPair};
    use std::sync::Mutex;
    use tempfile::tempdir;

    #[test]
    fn enforces_allowed_web_push_endpoints() {
        assert!(is_allowed_web_push_endpoint(
            "https://web.push.apple.com/QWERTY"
        ));
        assert!(is_allowed_web_push_endpoint(
            "https://fcm.googleapis.com/fcm/send/abc"
        ));
        assert!(is_allowed_web_push_endpoint(
            "https://updates.push.services.mozilla.com/wpush/v2/abc"
        ));
        assert!(is_allowed_web_push_endpoint(
            "https://wns2-bl2p.notify.windows.com/w/?token=123"
        ));

        assert!(!is_allowed_web_push_endpoint(
            "http://web.push.apple.com/QWERTY"
        ));
        assert!(!is_allowed_web_push_endpoint(
            "https://web.push.apple.com:8443/QWERTY"
        ));
        assert!(!is_allowed_web_push_endpoint(
            "https://user:pass@web.push.apple.com/QWERTY"
        ));
        assert!(!is_allowed_web_push_endpoint(
            "https://evil.example.com/push"
        ));
        assert!(!is_allowed_web_push_endpoint(
            "https://.notify.windows.com/push"
        ));
        assert!(!is_allowed_web_push_endpoint("not-a-url"));
    }

    #[test]
    fn matches_rfc8291_section_5_encryption_test_vector() {
        // Cross-verified against reference http_ece aes128gcm (RFC 8291 / RFC 8188).
        let ua_public = decode_base64url(
            "BPTX-_xEOYeUTJuRhcHdq9w3gE7tG_wHEXtBf9tsY-gpD2XtWhiTlxE__ru0vruLT7zHtNn6xSeL0E1OSpejg84",
        )
        .expect("ua_public");
        let as_public = decode_base64url(
            "BOWVk58VLi6vB_al3evjUmVZA2o8kqpErFHbuGofBHU3yFbzpl9EICFCVX7jBg-5hCl4QZPPo67UnOnzMLbrLik",
        )
        .expect("as_public");
        let ecdh_secret =
            decode_base64url("KIZp26QAMBjuMM3P4wtEVkjs6KJIPdj_F0vX8nzWtCo").expect("ecdh_secret");
        let auth_secret = decode_base64url("BTBZMqHH6r4Tts7J_aSIgg").expect("auth_secret");
        let salt: [u8; 16] = decode_base64url("DGv6ra1nlYgDCS1FRnbzlw")
            .expect("salt")
            .try_into()
            .expect("16B salt");
        let plaintext = b"When I grow up, I want to be a watermelon";

        let encrypted = encrypt_aes128gcm_with_secret(
            &ecdh_secret,
            &ua_public,
            &as_public,
            &auth_secret,
            &salt,
            plaintext,
            4096,
        )
        .expect("encrypt");

        // Exact reference http_ece aes128gcm ciphertext (144 bytes).
        let expected = decode_base64url(
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBOWVk58VLi6vB_al3evjUmVZA2o8kqpErFHbuGofBHU3yFbzpl9EICFCVX7jBg-5hCl4QZPPo67UnOnzMLbrLikKKvB7DMQlSF5fETqKul8vng9oanqXioy7NGALMi_dInqjHCkbpZni6_wHuiPKCh0pEAyBOq_VK087",
        )
        .expect("expected");
        assert_eq!(encrypted, expected);
    }

    #[test]
    fn round_trips_ecdh_web_push_encryption_and_verifies_vapid_jwt() {
        let rng = SystemRandom::new();
        let ua_private = EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).expect("ua");
        let ua_public = ua_private.compute_public_key().expect("ua pub");
        let mut auth_secret = [0u8; 16];
        rng.fill(&mut auth_secret).expect("auth");

        let payload = br#"{"type":"assistant_response","lane":"acopilot","project":"ads"}"#;
        let encrypted =
            encrypt_web_push_payload(ua_public.as_ref(), &auth_secret, payload).expect("encrypt");
        assert!(encrypted.len() > 86);
        let salt = &encrypted[..16];
        let rs = u32::from_be_bytes(encrypted[16..20].try_into().expect("rs"));
        assert_eq!(rs, 4096);
        assert_eq!(encrypted[20], 65);
        let as_public = &encrypted[21..86];
        let ciphertext = &encrypted[86..];

        // Decrypt independently on the simulated user-agent side.
        let as_peer = UnparsedPublicKey::new(&agreement::ECDH_P256, as_public);
        let decrypted = agreement::agree_ephemeral(ua_private, &as_peer, |shared_secret| {
            let hkdf_key = Hkdf::<Sha256>::new(Some(&auth_secret), shared_secret);
            let mut key_info = Vec::with_capacity(14 + 65 + 65);
            key_info.extend_from_slice(b"WebPush: info\0");
            key_info.extend_from_slice(ua_public.as_ref());
            key_info.extend_from_slice(as_public);
            let mut ikm = [0u8; 32];
            hkdf_key.expand(&key_info, &mut ikm).expect("ikm");

            let hkdf_content = Hkdf::<Sha256>::new(Some(salt), &ikm);
            let mut cek = [0u8; 16];
            hkdf_content
                .expand(b"Content-Encoding: aes128gcm\0", &mut cek)
                .expect("cek");
            let mut nonce_bytes = [0u8; 12];
            hkdf_content
                .expand(b"Content-Encoding: nonce\0", &mut nonce_bytes)
                .expect("nonce");
            let cipher = Aes128Gcm::new_from_slice(&cek).expect("cipher");
            cipher
                .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext)
                .expect("decrypt")
        })
        .expect("agree");
        assert_eq!(decrypted.last(), Some(&0x02));
        assert_eq!(&decrypted[..decrypted.len() - 1], payload);

        // Verify VAPID JWT signing with a fresh P-256 keypair.
        let pkcs8 =
            EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).expect("pkcs8");
        let kp = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
            .expect("kp");
        // Extract raw 32B private key from RFC 5958 PKCS#8 generated by ring (fixed offset in SEC1 ECPrivateKey).
        let raw_pub = kp.public_key().as_ref();
        let der = pkcs8.as_ref();
        let priv_marker = [0x04u8, 0x20];
        let priv_pos = der
            .windows(2)
            .position(|w| w == priv_marker)
            .expect("private scalar marker")
            + 2;
        let raw_priv = &der[priv_pos..priv_pos + 32];
        let config = WebPushConfig {
            public_key: Some(URL_SAFE_NO_PAD.encode(raw_pub)),
            private_key: Some(URL_SAFE_NO_PAD.encode(raw_priv)),
            subject: Some("mailto:ops@example.com".to_string()),
        };
        let signer = VapidSigner::from_config(&config)
            .expect("valid vapid")
            .expect("some signer");
        let auth_header = signer
            .authorization_header("https://web.push.apple.com/sub-1", 1_700_000_000)
            .expect("auth header");
        assert!(auth_header.starts_with("vapid t="));
        let jwt = auth_header
            .strip_prefix("vapid t=")
            .and_then(|rest| rest.split(", k=").next())
            .expect("jwt");
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let signing_input = format!("{}.{}", parts[0], parts[1]);
        let sig = decode_base64url(parts[2]).expect("sig");
        ring::signature::UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, raw_pub)
            .verify(signing_input.as_bytes(), &sig)
            .expect("verify ES256 signature");
    }

    struct MockTransport {
        status: u16,
        sent: Mutex<Vec<WebPushHttpRequest>>,
    }

    impl WebPushTransport for MockTransport {
        fn send<'a>(&'a self, request: WebPushHttpRequest) -> WebPushFuture<'a> {
            self.sent.lock().expect("sent lock").push(request);
            let status = self.status;
            Box::pin(async move { Ok(status) })
        }
    }

    #[tokio::test]
    async fn removes_stale_subscription_on_410_and_keeps_on_201() {
        let rng = SystemRandom::new();
        let pkcs8 =
            EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).expect("pkcs8");
        let kp = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
            .expect("kp");
        let raw_pub = kp.public_key().as_ref();
        let der = pkcs8.as_ref();
        let priv_pos = der
            .windows(2)
            .position(|w| w == [0x04u8, 0x20])
            .expect("priv marker")
            + 2;
        let config = WebPushConfig {
            public_key: Some(URL_SAFE_NO_PAD.encode(raw_pub)),
            private_key: Some(URL_SAFE_NO_PAD.encode(&der[priv_pos..priv_pos + 32])),
            subject: Some("mailto:ops@example.com".to_string()),
        };

        let ua_private = EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).expect("ua");
        let ua_pub = ua_private.compute_public_key().expect("ua pub");
        let mut auth = [0u8; 16];
        rng.fill(&mut auth).expect("auth");
        let sub = StoredWebPushSubscription {
            endpoint: "https://web.push.apple.com/device-1".to_string(),
            p256dh: URL_SAFE_NO_PAD.encode(ua_pub.as_ref()),
            auth: URL_SAFE_NO_PAD.encode(auth),
        };

        let dir = tempdir().expect("tempdir");
        let db = StateDb::open(dir.path().join("state.db")).expect("db");
        let transport_ok = Arc::new(MockTransport {
            status: 201,
            sent: Mutex::new(Vec::new()),
        });
        let service_ok =
            WebPushService::with_transport(db.clone(), config.clone(), transport_ok.clone());
        service_ok.save_subscription("user-1", &sub).expect("save");
        service_ok
            .notify_user(
                "user-1",
                WebPushNotification {
                    kind: WebPushNotificationType::AssistantResponse,
                    lane: Some("acopilot".to_string()),
                    project: Some("ads".to_string()),
                    session_id: Some("sess-1".to_string()),
                },
            )
            .await;
        assert_eq!(transport_ok.sent.lock().expect("sent").len(), 1);
        assert_eq!(
            list_web_push_subscriptions_by_user(&db.connect().expect("conn"), "user-1")
                .expect("list")
                .len(),
            1
        );

        let transport_gone = Arc::new(MockTransport {
            status: 410,
            sent: Mutex::new(Vec::new()),
        });
        let service_gone = WebPushService::with_transport(db.clone(), config, transport_gone);
        service_gone
            .notify_user(
                "user-1",
                WebPushNotification {
                    kind: WebPushNotificationType::PromptError,
                    lane: Some("acopilot".to_string()),
                    project: Some("ads".to_string()),
                    session_id: Some("sess-1".to_string()),
                },
            )
            .await;
        assert!(
            list_web_push_subscriptions_by_user(&db.connect().expect("conn"), "user-1")
                .expect("list")
                .is_empty()
        );
    }
}
