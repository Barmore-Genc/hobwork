use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use p256::ecdsa::{Signature, SigningKey, signature::Signer};
use p256::pkcs8::DecodePrivateKey;

use crate::store::Environment;

pub const MAX_PAYLOAD_BYTES: usize = 4096;
// APNs refuses provider tokens older than an hour and throttles ones renewed
// more often than every 20 minutes.
const JWT_TTL: Duration = Duration::from_secs(40 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
// NAT gateways drop idle connections without telling either side, and a push
// sent on such a connection hangs until it times out.
const IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushType {
    Alert,
    Background,
    LiveActivity,
}

#[derive(Debug, Clone)]
pub struct ApnsRequest {
    pub environment: Environment,
    pub token: String,
    pub push_type: PushType,
    pub priority: u8,
    /// Unix seconds; 0 means APNs tries once.
    pub expiration: i64,
    pub collapse_id: Option<String>,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApnsOutcome {
    Sent { apns_id: Option<String> },
    Refused { status: u16, reason: String },
    Unreachable(String),
}

impl ApnsOutcome {
    /// The token no longer reaches the app and should be forgotten.
    pub fn token_gone(&self) -> bool {
        matches!(self, ApnsOutcome::Refused { status, reason }
            if *status == 410 || reason == "BadDeviceToken" || reason == "DeviceTokenNotForTopic")
    }

    pub fn status(&self) -> Option<u16> {
        match self {
            ApnsOutcome::Sent { .. } => Some(200),
            ApnsOutcome::Refused { status, .. } => Some(*status),
            ApnsOutcome::Unreachable(_) => None,
        }
    }
}

#[async_trait]
pub trait Apns: Send + Sync {
    async fn send(&self, request: &ApnsRequest) -> ApnsOutcome;
}

pub struct ApnsConfig {
    pub key_pem: String,
    pub key_id: String,
    pub team_id: String,
    pub topic: String,
}

pub struct ApnsClient {
    key: SigningKey,
    key_id: String,
    team_id: String,
    topic: String,
    http: RwLock<reqwest::Client>,
    jwt: Mutex<Option<(String, Instant)>>,
}

fn http_client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .http2_prior_knowledge()
        .pool_idle_timeout(IDLE_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()?)
}

fn origin(environment: Environment) -> &'static str {
    match environment {
        Environment::Sandbox => "https://api.sandbox.push.apple.com",
        Environment::Production => "https://api.push.apple.com",
    }
}

pub fn topic(bundle_id: &str, push_type: PushType) -> String {
    match push_type {
        PushType::LiveActivity => format!("{bundle_id}.push-type.liveactivity"),
        PushType::Alert | PushType::Background => bundle_id.to_owned(),
    }
}

/// ES256 JWT for token-based APNs auth.
pub fn provider_token(key: &SigningKey, key_id: &str, team_id: &str, issued_at: u64) -> String {
    let header = URL_SAFE_NO_PAD.encode(serde_json::json!({ "alg": "ES256", "kid": key_id }).to_string());
    let claims = URL_SAFE_NO_PAD.encode(serde_json::json!({ "iss": team_id, "iat": issued_at }).to_string());
    let signature: Signature = key.sign(format!("{header}.{claims}").as_bytes());
    format!("{header}.{claims}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
}

impl ApnsClient {
    pub fn new(config: ApnsConfig) -> Result<Self> {
        let key =
            SigningKey::from_pkcs8_pem(&config.key_pem).context("the APNs key is not a .p8 private key from Apple")?;
        Ok(Self {
            key,
            key_id: config.key_id,
            team_id: config.team_id,
            topic: config.topic,
            http: RwLock::new(http_client()?),
            jwt: Mutex::new(None),
        })
    }

    fn token(&self) -> String {
        let mut jwt = self.jwt.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((value, issued)) = jwt.as_ref()
            && issued.elapsed() < JWT_TTL
        {
            return value.clone();
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let value = provider_token(&self.key, &self.key_id, &self.team_id, now);
        *jwt = Some((value.clone(), Instant::now()));
        value
    }

    fn http(&self) -> reqwest::Client {
        self.http.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    // A request that gets no answer usually means the connection is dead.
    // reqwest cannot drop one pooled connection, so the whole pool goes.
    fn reset_http(&self) {
        if let Ok(client) = http_client() {
            *self.http.write().unwrap_or_else(|p| p.into_inner()) = client;
        }
    }

    async fn request(&self, request: &ApnsRequest) -> Result<ApnsOutcome, reqwest::Error> {
        let url = format!("{}/3/device/{}", origin(request.environment), request.token);
        let push_type = match request.push_type {
            PushType::Alert => "alert",
            PushType::Background => "background",
            PushType::LiveActivity => "liveactivity",
        };
        let mut builder = self
            .http()
            .post(url)
            .header("authorization", format!("bearer {}", self.token()))
            .header("apns-topic", topic(&self.topic, request.push_type))
            .header("apns-push-type", push_type)
            .header("apns-priority", request.priority.to_string())
            .header("apns-expiration", request.expiration.to_string())
            .header("content-type", "application/json")
            .body(request.payload.clone());
        if let Some(collapse_id) = &request.collapse_id {
            builder = builder.header("apns-collapse-id", collapse_id);
        }
        let response = builder.send().await?;
        let status = response.status().as_u16();
        let apns_id = response
            .headers()
            .get("apns-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let body = response.bytes().await?;
        if status == 200 {
            return Ok(ApnsOutcome::Sent { apns_id });
        }
        let reason = serde_json::from_slice::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("reason").and_then(|r| r.as_str()).map(str::to_owned))
            .unwrap_or_else(|| format!("HTTP {status}"));
        Ok(ApnsOutcome::Refused { status, reason })
    }
}

#[async_trait]
impl Apns for ApnsClient {
    async fn send(&self, request: &ApnsRequest) -> ApnsOutcome {
        // One retry on a new connection when the pooled one turns out to be dead.
        // The collapse ID keeps a push that did arrive from showing twice.
        let mut result = self.request(request).await;
        if result.is_err() {
            self.reset_http();
            result = self.request(request).await;
        }
        if let Ok(ApnsOutcome::Refused { status: 403, reason }) = &result
            && reason == "ExpiredProviderToken"
        {
            *self.jwt.lock().unwrap_or_else(|p| p.into_inner()) = None;
            result = self.request(request).await;
        }
        result.unwrap_or_else(|err| ApnsOutcome::Unreachable(err.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Verifier;
    use p256::pkcs8::EncodePrivateKey;

    fn test_key() -> SigningKey {
        let mut secret = [0u8; 32];
        rand::fill(&mut secret);
        SigningKey::from_slice(&secret).unwrap()
    }

    #[test]
    fn provider_tokens_are_es256_jwts() {
        let key = test_key();
        let jwt = provider_token(&key, "KEY123", "TEAM456", 1_700_000_000);
        let parts: Vec<&str> = jwt.split('.').collect();
        let header: serde_json::Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
        let claims: serde_json::Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(header, serde_json::json!({ "alg": "ES256", "kid": "KEY123" }));
        assert_eq!(claims, serde_json::json!({ "iss": "TEAM456", "iat": 1_700_000_000 }));
        let signature = Signature::from_slice(&URL_SAFE_NO_PAD.decode(parts[2]).unwrap()).unwrap();
        key.verifying_key()
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
            .unwrap();
    }

    #[test]
    fn live_activities_have_their_own_topic() {
        assert_eq!(topic("dev.bgenc.hobwork", PushType::Alert), "dev.bgenc.hobwork");
        assert_eq!(topic("dev.bgenc.hobwork", PushType::Background), "dev.bgenc.hobwork");
        assert_eq!(
            topic("dev.bgenc.hobwork", PushType::LiveActivity),
            "dev.bgenc.hobwork.push-type.liveactivity"
        );
    }

    /// Talks to Apple's sandbox with a key Apple does not know, to check that
    /// HTTP/2 and TLS work: `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn apple_answers_over_http2() {
        let pem = test_key().to_pkcs8_pem(Default::default()).unwrap();
        let client = ApnsClient::new(ApnsConfig {
            key_pem: pem.to_string(),
            key_id: "ABCDEFGHIJ".into(),
            team_id: "ABCDEFGHIJ".into(),
            topic: "dev.bgenc.hobwork".into(),
        })
        .unwrap();
        let outcome = client
            .send(&ApnsRequest {
                environment: Environment::Sandbox,
                token: "00".repeat(32),
                push_type: PushType::Alert,
                priority: 10,
                expiration: 0,
                collapse_id: None,
                payload: br#"{"aps":{}}"#.to_vec(),
            })
            .await;
        assert!(
            matches!(outcome, ApnsOutcome::Refused { status: 403, .. }),
            "{outcome:?}"
        );
    }
}
