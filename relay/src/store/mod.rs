mod sqlite;

pub use sqlite::SqliteStore;

use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    Sandbox,
    Production,
}

impl Environment {
    pub fn as_str(self) -> &'static str {
        match self {
            Environment::Sandbox => "sandbox",
            Environment::Production => "production",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "sandbox" => Some(Environment::Sandbox),
            "production" => Some(Environment::Production),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PendingToken {
    pub token: String,
    pub environment: Environment,
    pub nonce: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone)]
pub struct AttestKey {
    pub key_id: Vec<u8>,
    pub public_key: Vec<u8>,
    pub counter: u32,
}

#[derive(Debug, Clone)]
pub struct Registration {
    pub id: String,
    pub secret_hash: Vec<u8>,
    /// The token that passed the ownership proof. `None` until the first proof
    /// and after APNs reports the token as gone.
    pub token: Option<String>,
    pub environment: Option<Environment>,
    pub pending: Option<PendingToken>,
    pub attest: Option<AttestKey>,
    pub created_at: i64,
    pub gone_at: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct Grant {
    pub id: String,
    pub registration_id: String,
    pub pairing: String,
    pub public_key: Vec<u8>,
    pub created_at: i64,
    pub renewed_at: i64,
    pub expires_at: i64,
    pub next_renewal_push_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityKind {
    /// Push-to-start: starts a new Live Activity.
    Start,
    /// Updates or ends one running Live Activity.
    Update,
}

impl ActivityKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ActivityKind::Start => "start",
            ActivityKind::Update => "update",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "start" => Some(ActivityKind::Start),
            "update" => Some(ActivityKind::Update),
            _ => None,
        }
    }
}

/// An ActivityKit push token, which is an APNs token like the registration's.
#[derive(Debug, Clone)]
pub struct ActivityToken {
    pub id: String,
    pub grant_id: String,
    pub kind: ActivityKind,
    pub token: String,
    pub created_at: i64,
    pub expires_at: Option<i64>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ConfirmOutcome {
    Confirmed,
    /// No pending token, or its nonce does not match.
    NoMatch,
    /// An attested registration holds the token and this one is not attested.
    AttestedConflict,
}

#[derive(Debug, Default)]
pub struct Event<'a> {
    pub ip_hash: Option<&'a str>,
    pub registration_id: Option<&'a str>,
    pub grant_id: Option<&'a str>,
    pub action: &'a str,
    pub result: &'a str,
    pub apns_status: Option<u16>,
}

#[derive(Debug, Clone)]
pub struct Retention {
    pub events: i64,
    pub ip_key: i64,
    pub unconfirmed_registration: i64,
    pub expired_grant: i64,
    pub gone_registration: i64,
}

pub trait Store: Send + Sync {
    fn create_registration(&self, registration: &Registration, now: i64) -> Result<()>;
    fn registration(&self, id: &str) -> Result<Option<Registration>>;
    fn registration_by_token(&self, token: &str) -> Result<Option<Registration>>;
    fn delete_registration(&self, id: &str) -> Result<bool>;
    fn set_pending_token(&self, id: &str, pending: Option<&PendingToken>) -> Result<()>;
    /// Makes the pending token the registration's token if `nonce` matches and
    /// has not expired. Another registration holding the token is deleted, and a
    /// registration that was gone loses its grants, since hosts forgot them.
    fn confirm_token(&self, id: &str, nonce: &str, now: i64) -> Result<ConfirmOutcome>;
    fn mark_gone(&self, id: &str, now: i64) -> Result<()>;
    fn touch_registration(&self, id: &str, now: i64) -> Result<()>;
    /// Returns false when `counter` is not above the stored one.
    fn advance_attest_counter(&self, id: &str, counter: u32) -> Result<bool>;

    /// Replaces any grant of the same registration and pairing.
    fn put_grant(&self, grant: &Grant) -> Result<()>;
    fn grant(&self, id: &str) -> Result<Option<Grant>>;
    fn grants(&self, registration_id: &str) -> Result<Vec<Grant>>;
    fn renew_grant(&self, id: &str, now: i64, expires_at: i64, next_renewal_push_at: i64) -> Result<()>;
    fn delete_grant(&self, registration_id: &str, id: &str) -> Result<bool>;
    /// Unexpired grants of live registrations whose renewal push is due.
    fn due_renewals(&self, now: i64) -> Result<Vec<Grant>>;
    fn set_next_renewal_push(&self, grant_ids: &[String], at: i64) -> Result<()>;

    /// Returns the grant's token of the same kind and value when there is one.
    /// Otherwise stores `token`, deleting the grant's other start token, or
    /// its oldest update tokens past `max_update`.
    fn put_activity_token(&self, token: &ActivityToken, max_update: usize) -> Result<ActivityToken>;
    fn activity_token(&self, id: &str) -> Result<Option<ActivityToken>>;
    fn delete_activity_token(&self, grant_id: &str, id: &str) -> Result<bool>;

    /// Returns false when the nonce was already used with this grant.
    fn use_request_nonce(&self, grant_id: &str, nonce: &str, expires_at: i64) -> Result<bool>;
    fn create_attest_challenge(&self, challenge: &str, expires_at: i64) -> Result<()>;
    /// Returns false for an unknown, used or expired challenge.
    fn take_attest_challenge(&self, challenge: &str, now: i64) -> Result<bool>;

    /// The key for hashing client IPs. A key older than `max_age` is deleted
    /// and replaced, so older hashes cannot be linked to newer ones.
    fn ip_key(&self, now: i64, max_age: i64) -> Result<Vec<u8>>;
    fn log(&self, event: &Event, now: i64) -> Result<()>;
    fn cleanup(&self, now: i64, retention: &Retention) -> Result<()>;
}
