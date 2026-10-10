use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, DefaultBodyLimit, FromRequestParts, Path, State as AxumState};
use axum::http::request::Parts;
use axum::http::{HeaderMap, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use ed25519_dalek::{Signature as EdSignature, VerifyingKey as EdKey};
use hmac::{Hmac, KeyInit, Mac};
use ipnet::IpNet;
use serde::Deserialize;
use serde::de::{DeserializeOwned, IgnoredAny};
use serde_json::{Number, Value, json};
use sha2::Sha256;

use crate::apns::{Apns, ApnsOutcome, ApnsRequest, MAX_PAYLOAD_BYTES, PushType};
use crate::attest::Verifier;
use crate::limits::Limits;
use crate::payload::{self, ActivityEvent, Kind, LiveActivity};
use crate::store::{
    ActivityKind, ActivityToken, AttestKey, ConfirmOutcome, Environment, Event, Grant, PendingToken, Registration,
    Store,
};
use crate::util::{b64, constant_time_eq, from_b64, random_token, sha256};

pub const MINUTE: i64 = 60;
pub const DAY: i64 = 24 * 60 * MINUTE;
pub const PROOF_TTL: i64 = 5 * MINUTE;
pub const CHALLENGE_TTL: i64 = 5 * MINUTE;
pub const GRANT_TTL: i64 = 30 * DAY;
pub const RENEW_AFTER: i64 = 15 * DAY;
pub const SIGNATURE_WINDOW: i64 = 5 * MINUTE;
pub const IP_KEY_MAX_AGE: i64 = 7 * DAY;
/// A Live Activity runs for at most 8 hours and stays on the lock screen for
/// up to 4 more, so its update token is of no use after that.
pub const ACTIVITY_TOKEN_TTL: i64 = 13 * 60 * MINUTE;
pub const MAX_UPDATE_TOKENS: usize = 16;
const MAX_BODY_BYTES: usize = 32 * 1024;
const MAX_EXPIRATION: i64 = 30 * DAY;

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub struct State {
    pub store: Arc<dyn Store>,
    pub apns: Arc<dyn Apns>,
    pub verifier: Verifier,
    pub limits: Limits,
    pub trusted_proxies: Vec<IpNet>,
    pub clock: Clock,
}

pub type AppState = Arc<State>;

impl State {
    pub fn now(&self) -> i64 {
        (self.clock)()
    }

    fn ip_hash(&self, ip: IpAddr) -> Option<String> {
        let key = self
            .store
            .ip_key(self.now(), IP_KEY_MAX_AGE)
            .map_err(|err| tracing::error!("cannot read the IP key: {err:#}"))
            .ok()?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&key).ok()?;
        mac.update(ip.to_string().as_bytes());
        Some(hex::encode(&mac.finalize().into_bytes()[..16]))
    }

    pub fn log(&self, event: &Event) {
        if let Err(err) = self.store.log(event, self.now()) {
            tracing::error!("cannot write an event: {err:#}");
        }
    }

    fn finish(&self, ip: IpAddr, audit: Audit, result: Result<Response, ApiError>) -> Response {
        let ip_hash = self.ip_hash(ip);
        self.log(&Event {
            ip_hash: ip_hash.as_deref(),
            registration_id: audit.registration_id.as_deref(),
            grant_id: audit.grant_id.as_deref(),
            action: audit.action,
            result: result.as_ref().map_or_else(|err| err.code, |_| "ok"),
            apns_status: audit.apns_status,
        });
        result.unwrap_or_else(IntoResponse::into_response)
    }
}

struct Audit {
    action: &'static str,
    registration_id: Option<String>,
    grant_id: Option<String>,
    apns_status: Option<u16>,
}

impl Audit {
    fn new(action: &'static str) -> Self {
        Self {
            action,
            registration_id: None,
            grant_id: None,
            apns_status: None,
        }
    }
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
    extra: Option<Value>,
}

fn api_error(status: StatusCode, code: &'static str, message: impl Into<String>) -> ApiError {
    ApiError {
        status,
        code,
        message: message.into(),
        extra: None,
    }
}

fn bad_request(message: impl Into<String>) -> ApiError {
    api_error(StatusCode::BAD_REQUEST, "bad_request", message)
}

fn unauthorized() -> ApiError {
    api_error(
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        "The registration or its secret is wrong.",
    )
}

fn rate_limited() -> ApiError {
    api_error(
        StatusCode::TOO_MANY_REQUESTS,
        "rate_limited",
        "Too many requests. Try again later.",
    )
}

impl From<anyhow::Error> for ApiError {
    fn from(err: anyhow::Error) -> Self {
        tracing::error!("{err:#}");
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "Something went wrong in the relay.",
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({ "error": self.code, "message": self.message });
        if let (Some(Value::Object(extra)), Some(object)) = (self.extra, body.as_object_mut()) {
            object.extend(extra);
        }
        (self.status, Json(body)).into_response()
    }
}

type ApiResult = Result<Response, ApiError>;

/// The client address, taken from `X-Forwarded-For` only when the connection
/// comes from a trusted proxy.
pub struct ClientIp(pub IpAddr);

pub fn client_ip(peer: IpAddr, forwarded_for: Option<&str>, trusted: &[IpNet]) -> IpAddr {
    let is_trusted = |ip: &IpAddr| trusted.iter().any(|net| net.contains(ip));
    if !is_trusted(&peer) {
        return peer;
    }
    let hops: Vec<IpAddr> = forwarded_for
        .unwrap_or_default()
        .split(',')
        .filter_map(|hop| hop.trim().parse().ok())
        .collect();
    hops.iter()
        .rev()
        .find(|ip| !is_trusted(ip))
        .or(hops.first())
        .copied()
        .unwrap_or(peer)
}

/// IPv6 clients usually get a whole /64, so per-IP limits count the /64.
fn limit_key(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => {
            let s = v6.segments();
            format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
        }
    }
}

impl FromRequestParts<AppState> for ClientIp {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED), |info| info.0.ip());
        let forwarded = parts.headers.get("x-forwarded-for").and_then(|v| v.to_str().ok());
        Ok(ClientIp(client_ip(peer, forwarded, &state.trusted_proxies)))
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/privacy", get(privacy))
        .route("/v1/attest/challenges", post(create_challenge))
        .route("/v1/registrations", post(create_registration))
        .route(
            "/v1/registrations/{id}",
            get(get_registration)
                .put(update_registration)
                .delete(delete_registration),
        )
        .route("/v1/registrations/{id}/proof", post(confirm_proof))
        .route("/v1/registrations/{id}/proof-push", post(resend_proof))
        .route("/v1/registrations/{id}/grants", post(create_grant))
        .route("/v1/registrations/{id}/grants/{grant}", delete(revoke_grant))
        .route("/v1/registrations/{id}/grants/{grant}/renew", post(renew_grant))
        .route(
            "/v1/registrations/{id}/grants/{grant}/activity-tokens",
            post(create_activity_token),
        )
        .route(
            "/v1/registrations/{id}/grants/{grant}/activity-tokens/{token}",
            delete(delete_activity_token),
        )
        .route("/v1/grants/{grant}/push", post(push))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state)
}

async fn privacy() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/markdown; charset=utf-8")],
        include_str!("../PRIVACY.md"),
    )
}

fn parse_json<T: DeserializeOwned>(body: &[u8]) -> Result<T, ApiError> {
    serde_json::from_slice(body).map_err(|err| bad_request(format!("The body is not valid: {err}")))
}

fn created(body: Value) -> Response {
    (StatusCode::CREATED, Json(body)).into_response()
}

fn ok(body: Value) -> Response {
    Json(body).into_response()
}

fn no_content() -> Response {
    StatusCode::NO_CONTENT.into_response()
}

fn parse_token(token: &str) -> Result<String, ApiError> {
    let token = token.to_ascii_lowercase();
    if token.len() < 32
        || token.len() > 200
        || !token.len().is_multiple_of(2)
        || !token.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(bad_request("token must be the APNs device token in hex."));
    }
    Ok(token)
}

fn body_hash(body: &[u8]) -> String {
    hex::encode(sha256(body))
}

fn registration_status(registration: &Registration) -> &'static str {
    if registration.token.is_some() {
        "active"
    } else if registration.gone_at.is_some() {
        "gone"
    } else {
        "pending"
    }
}

async fn send_proof(
    state: &State,
    registration_id: &str,
    token: &str,
    environment: Environment,
) -> Result<ApnsOutcome, ApiError> {
    let now = state.now();
    let pending = PendingToken {
        token: token.to_owned(),
        environment,
        nonce: random_token(16),
        expires_at: now + PROOF_TTL,
    };
    state.store.set_pending_token(registration_id, Some(&pending))?;
    let outcome = state
        .apns
        .send(&ApnsRequest {
            environment,
            token: token.to_owned(),
            push_type: PushType::Alert,
            priority: 10,
            expiration: now + PROOF_TTL,
            collapse_id: Some("hobwork-proof".into()),
            payload: payload::proof(&pending.nonce).to_string().into_bytes(),
        })
        .await;
    Ok(outcome)
}

fn proof_failure(outcome: &ApnsOutcome) -> ApiError {
    if outcome.token_gone() {
        return api_error(StatusCode::BAD_REQUEST, "bad_token", "APNs does not accept this token.");
    }
    push_failed(outcome)
}

fn push_failed(outcome: &ApnsOutcome) -> ApiError {
    let (apns_status, reason) = match outcome {
        ApnsOutcome::Refused { status, reason } => (Some(*status), reason.clone()),
        ApnsOutcome::Unreachable(reason) => (None, reason.clone()),
        ApnsOutcome::Sent { .. } => (Some(200), String::new()),
    };
    ApiError {
        status: StatusCode::BAD_GATEWAY,
        code: "push_failed",
        message: format!("APNs did not take the push: {reason}"),
        extra: Some(json!({ "apnsStatus": apns_status, "reason": reason })),
    }
}

/// Checks the registration secret and, for attested registrations, the App
/// Attest assertion over the request.
async fn authorize(
    state: &State,
    id: &str,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<Registration, ApiError> {
    let registration = state.store.registration(id)?.ok_or_else(unauthorized)?;
    let secret = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(unauthorized)?;
    if !constant_time_eq(&sha256(secret.as_bytes()), &registration.secret_hash) {
        return Err(unauthorized());
    }
    if let Some(attest) = &registration.attest {
        let assertion = headers
            .get("hobwork-assertion")
            .and_then(|v| v.to_str().ok())
            .and_then(from_b64)
            .ok_or_else(|| {
                api_error(
                    StatusCode::UNAUTHORIZED,
                    "assertion_required",
                    "This registration needs an App Attest assertion.",
                )
            })?;
        let client_data = format!("{method}\n{}\n{}", uri.path(), body_hash(body));
        let counter = state
            .verifier
            .verify_assertion(&assertion, client_data.as_bytes(), &attest.public_key)
            .map_err(|err| api_error(StatusCode::UNAUTHORIZED, "bad_assertion", err.to_string()))?;
        if !state.store.advance_attest_counter(id, counter)? {
            return Err(api_error(
                StatusCode::UNAUTHORIZED,
                "bad_assertion",
                "The assertion was already used.",
            ));
        }
    }
    state.store.touch_registration(id, state.now())?;
    Ok(registration)
}

async fn create_challenge(AxumState(state): AxumState<AppState>, ClientIp(ip): ClientIp) -> Response {
    let result = async {
        if !state.limits.ip_grant.check(&limit_key(ip)) {
            return Err(rate_limited());
        }
        let challenge = random_token(32);
        state
            .store
            .create_attest_challenge(&challenge, state.now() + CHALLENGE_TTL)?;
        Ok(created(json!({ "challenge": challenge })))
    }
    .await;
    state.finish(ip, Audit::new("attest_challenge"), result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttestationBody {
    key_id: String,
    object: String,
    challenge: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegisterBody {
    token: String,
    environment: Environment,
    /// Accepted because older apps send it.
    #[serde(default, rename = "filtering")]
    _filtering: Option<IgnoredAny>,
    attestation: Option<AttestationBody>,
}

async fn create_registration(AxumState(state): AxumState<AppState>, ClientIp(ip): ClientIp, body: Bytes) -> Response {
    let mut audit = Audit::new("register");
    let result = register(&state, ip, &body, &mut audit).await;
    state.finish(ip, audit, result)
}

async fn register(state: &State, ip: IpAddr, body: &[u8], audit: &mut Audit) -> ApiResult {
    if !state.limits.ip_registration.check(&limit_key(ip)) {
        return Err(rate_limited());
    }
    let body: RegisterBody = parse_json(body)?;
    let token = parse_token(&body.token)?;
    let now = state.now();

    let attest = match body.attestation {
        Some(attestation) => {
            if !state.store.take_attest_challenge(&attestation.challenge, now)? {
                return Err(api_error(
                    StatusCode::BAD_REQUEST,
                    "bad_challenge",
                    "The challenge is unknown, used or expired.",
                ));
            }
            let key_id = from_b64(&attestation.key_id).ok_or_else(|| bad_request("keyId is not base64."))?;
            let object = from_b64(&attestation.object).ok_or_else(|| bad_request("object is not base64."))?;
            let key = state
                .verifier
                .verify_attestation(
                    &object,
                    &key_id,
                    &sha256(attestation.challenge.as_bytes()),
                    body.environment,
                    now,
                )
                .map_err(|err| api_error(StatusCode::BAD_REQUEST, "bad_attestation", err.to_string()))?;
            Some(AttestKey {
                key_id: key.key_id,
                public_key: key.public_key,
                counter: 0,
            })
        }
        None => {
            if state
                .store
                .registration_by_token(&token)?
                .is_some_and(|holder| holder.attest.is_some())
            {
                return Err(attested_token());
            }
            None
        }
    };

    let secret = random_token(32);
    let registration = Registration {
        id: random_token(16),
        secret_hash: sha256(secret.as_bytes()).to_vec(),
        token: None,
        environment: None,
        pending: None,
        attest,
        created_at: now,
        gone_at: None,
    };
    state.store.create_registration(&registration, now)?;
    audit.registration_id = Some(registration.id.clone());

    let outcome = send_proof(state, &registration.id, &token, body.environment).await?;
    audit.apns_status = outcome.status();
    if !matches!(outcome, ApnsOutcome::Sent { .. }) {
        state.store.delete_registration(&registration.id)?;
        return Err(proof_failure(&outcome));
    }
    Ok(created(
        json!({ "id": registration.id, "secret": secret, "status": "pending" }),
    ))
}

fn attested_token() -> ApiError {
    api_error(
        StatusCode::CONFLICT,
        "attested_token",
        "An attested registration holds this token, so this one needs App Attest too.",
    )
}

async fn get_registration(
    AxumState(state): AxumState<AppState>,
    Path(id): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let registration = authorize(&state, &id, &method, &uri, &headers, &body).await?;
    let grants: Vec<Value> = state
        .store
        .grants(&id)?
        .into_iter()
        .map(|g| json!({ "id": g.id, "pairing": g.pairing, "expiresAt": g.expires_at }))
        .collect();
    Ok(ok(json!({
        "id": registration.id,
        "status": registration_status(&registration),
        "environment": registration.environment,
        "attested": registration.attest.is_some(),
        "grants": grants,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateBody {
    token: String,
    environment: Environment,
    /// Accepted because older apps send it.
    #[serde(default, rename = "filtering")]
    _filtering: Option<IgnoredAny>,
}

async fn update_registration(
    AxumState(state): AxumState<AppState>,
    ClientIp(ip): ClientIp,
    Path(id): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut audit = Audit::new("update");
    audit.registration_id = Some(id.clone());
    let result = async {
        let registration = authorize(&state, &id, &method, &uri, &headers, &body).await?;
        let update: UpdateBody = parse_json(&body)?;
        let token = parse_token(&update.token)?;
        if registration.token.as_deref() == Some(token.as_str()) && registration.environment == Some(update.environment)
        {
            return Ok(ok(json!({ "status": "active" })));
        }
        if registration.attest.is_none()
            && state
                .store
                .registration_by_token(&token)?
                .is_some_and(|holder| holder.attest.is_some())
        {
            return Err(attested_token());
        }
        if !state.limits.ip_registration.check(&limit_key(ip)) || !state.limits.registration_proof.check(&id) {
            return Err(rate_limited());
        }
        let outcome = send_proof(&state, &id, &token, update.environment).await?;
        audit.apns_status = outcome.status();
        if !matches!(outcome, ApnsOutcome::Sent { .. }) {
            state.store.set_pending_token(&id, None)?;
            return Err(proof_failure(&outcome));
        }
        Ok((StatusCode::ACCEPTED, Json(json!({ "status": "pending" }))).into_response())
    }
    .await;
    state.finish(ip, audit, result)
}

async fn delete_registration(
    AxumState(state): AxumState<AppState>,
    ClientIp(ip): ClientIp,
    Path(id): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut audit = Audit::new("delete");
    audit.registration_id = Some(id.clone());
    let result = async {
        authorize(&state, &id, &method, &uri, &headers, &body).await?;
        state.store.delete_registration(&id)?;
        Ok(no_content())
    }
    .await;
    state.finish(ip, audit, result)
}

async fn resend_proof(
    AxumState(state): AxumState<AppState>,
    ClientIp(ip): ClientIp,
    Path(id): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut audit = Audit::new("proof_push");
    audit.registration_id = Some(id.clone());
    let result = async {
        let registration = authorize(&state, &id, &method, &uri, &headers, &body).await?;
        let Some(pending) = registration.pending else {
            return Err(api_error(
                StatusCode::CONFLICT,
                "nothing_pending",
                "There is no token waiting for its proof.",
            ));
        };
        if !state.limits.ip_registration.check(&limit_key(ip)) || !state.limits.registration_proof.check(&id) {
            return Err(rate_limited());
        }
        let outcome = send_proof(&state, &id, &pending.token, pending.environment).await?;
        audit.apns_status = outcome.status();
        if !matches!(outcome, ApnsOutcome::Sent { .. }) {
            return Err(proof_failure(&outcome));
        }
        Ok(no_content())
    }
    .await;
    state.finish(ip, audit, result)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProofBody {
    nonce: String,
}

async fn confirm_proof(
    AxumState(state): AxumState<AppState>,
    ClientIp(ip): ClientIp,
    Path(id): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut audit = Audit::new("proof");
    audit.registration_id = Some(id.clone());
    let result = async {
        authorize(&state, &id, &method, &uri, &headers, &body).await?;
        let proof: ProofBody = parse_json(&body)?;
        match state.store.confirm_token(&id, &proof.nonce, state.now())? {
            ConfirmOutcome::Confirmed => Ok(ok(json!({ "status": "active" }))),
            ConfirmOutcome::NoMatch => Err(api_error(
                StatusCode::BAD_REQUEST,
                "bad_nonce",
                "The nonce does not match or has expired. Ask for a new proof push.",
            )),
            ConfirmOutcome::AttestedConflict => Err(attested_token()),
        }
    }
    .await;
    state.finish(ip, audit, result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GrantBody {
    pairing: String,
    public_key: String,
}

pub fn next_renewal_push(renewed_at: i64) -> i64 {
    renewed_at + RENEW_AFTER + rand::random_range(0..DAY)
}

async fn create_grant(
    AxumState(state): AxumState<AppState>,
    ClientIp(ip): ClientIp,
    Path(id): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut audit = Audit::new("grant");
    audit.registration_id = Some(id.clone());
    let result = async {
        let registration = authorize(&state, &id, &method, &uri, &headers, &body).await?;
        if registration.token.is_none() {
            return Err(api_error(
                StatusCode::CONFLICT,
                "not_active",
                "The registration has no confirmed token.",
            ));
        }
        if !state.limits.ip_grant.check(&limit_key(ip)) {
            return Err(rate_limited());
        }
        let grant: GrantBody = parse_json(&body)?;
        if grant.pairing.is_empty() || grant.pairing.len() > 128 {
            return Err(bad_request("pairing must be 1 to 128 bytes."));
        }
        let public_key = from_b64(&grant.public_key)
            .and_then(|key| <[u8; 32]>::try_from(key).ok())
            .filter(|key| EdKey::from_bytes(key).is_ok())
            .ok_or_else(|| bad_request("publicKey must be an Ed25519 public key in base64."))?;
        let now = state.now();
        let grant = Grant {
            id: random_token(16),
            registration_id: id.clone(),
            pairing: grant.pairing,
            public_key: public_key.to_vec(),
            created_at: now,
            renewed_at: now,
            expires_at: now + GRANT_TTL,
            next_renewal_push_at: next_renewal_push(now),
        };
        state.store.put_grant(&grant)?;
        audit.grant_id = Some(grant.id.clone());
        Ok(created(json!({ "id": grant.id, "expiresAt": grant.expires_at })))
    }
    .await;
    state.finish(ip, audit, result)
}

fn unknown_grant() -> ApiError {
    api_error(StatusCode::NOT_FOUND, "unknown_grant", "There is no such grant.")
}

async fn renew_grant(
    AxumState(state): AxumState<AppState>,
    ClientIp(ip): ClientIp,
    Path((id, grant_id)): Path<(String, String)>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut audit = Audit::new("renew");
    audit.registration_id = Some(id.clone());
    audit.grant_id = Some(grant_id.clone());
    let result = async {
        let registration = authorize(&state, &id, &method, &uri, &headers, &body).await?;
        let grant = state
            .store
            .grant(&grant_id)?
            .filter(|g| g.registration_id == id)
            .ok_or_else(unknown_grant)?;
        let now = state.now();
        if registration.token.is_none() {
            return Err(gone());
        }
        if grant.expires_at <= now {
            return Err(expired());
        }
        let expires_at = now + GRANT_TTL;
        state
            .store
            .renew_grant(&grant_id, now, expires_at, next_renewal_push(now))?;
        Ok(ok(json!({ "expiresAt": expires_at })))
    }
    .await;
    state.finish(ip, audit, result)
}

async fn revoke_grant(
    AxumState(state): AxumState<AppState>,
    ClientIp(ip): ClientIp,
    Path((id, grant_id)): Path<(String, String)>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut audit = Audit::new("revoke");
    audit.registration_id = Some(id.clone());
    audit.grant_id = Some(grant_id.clone());
    let result = async {
        authorize(&state, &id, &method, &uri, &headers, &body).await?;
        if !state.store.delete_grant(&id, &grant_id)? {
            return Err(unknown_grant());
        }
        Ok(no_content())
    }
    .await;
    state.finish(ip, audit, result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActivityTokenBody {
    kind: ActivityKind,
    token: String,
}

async fn create_activity_token(
    AxumState(state): AxumState<AppState>,
    ClientIp(ip): ClientIp,
    Path((id, grant_id)): Path<(String, String)>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut audit = Audit::new("activity_token");
    audit.registration_id = Some(id.clone());
    audit.grant_id = Some(grant_id.clone());
    let result = async {
        let registration = authorize(&state, &id, &method, &uri, &headers, &body).await?;
        if registration.token.is_none() {
            return Err(api_error(
                StatusCode::CONFLICT,
                "not_active",
                "The registration has no confirmed token.",
            ));
        }
        if !state.limits.ip_grant.check(&limit_key(ip)) {
            return Err(rate_limited());
        }
        let grant = state
            .store
            .grant(&grant_id)?
            .filter(|g| g.registration_id == id)
            .ok_or_else(unknown_grant)?;
        let now = state.now();
        if grant.expires_at <= now {
            return Err(expired());
        }
        let request: ActivityTokenBody = parse_json(&body)?;
        let token = parse_token(&request.token)?;
        let stored = state.store.put_activity_token(
            &ActivityToken {
                id: random_token(16),
                grant_id: grant.id,
                kind: request.kind,
                token,
                created_at: now,
                expires_at: match request.kind {
                    ActivityKind::Start => None,
                    ActivityKind::Update => Some(now + ACTIVITY_TOKEN_TTL),
                },
            },
            MAX_UPDATE_TOKENS,
        )?;
        Ok(created(json!({ "id": stored.id, "expiresAt": stored.expires_at })))
    }
    .await;
    state.finish(ip, audit, result)
}

async fn delete_activity_token(
    AxumState(state): AxumState<AppState>,
    ClientIp(ip): ClientIp,
    Path((id, grant_id, token_id)): Path<(String, String, String)>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut audit = Audit::new("activity_token_delete");
    audit.registration_id = Some(id.clone());
    audit.grant_id = Some(grant_id.clone());
    let result = async {
        authorize(&state, &id, &method, &uri, &headers, &body).await?;
        state
            .store
            .grant(&grant_id)?
            .filter(|g| g.registration_id == id)
            .ok_or_else(unknown_grant)?;
        state.store.delete_activity_token(&grant_id, &token_id)?;
        Ok(no_content())
    }
    .await;
    state.finish(ip, audit, result)
}

fn gone() -> ApiError {
    api_error(
        StatusCode::GONE,
        "gone",
        "The device no longer takes pushes. Forget this grant.",
    )
}

fn expired() -> ApiError {
    api_error(StatusCode::GONE, "expired", "The grant has expired.")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PushBody {
    kind: Kind,
    #[serde(default = "default_priority")]
    priority: u8,
    expiration: Option<i64>,
    collapse_id: Option<String>,
    key_id: String,
    ciphertext: String,
    activity: Option<String>,
    event: Option<ActivityEvent>,
    timestamp: Option<i64>,
    stale_date: Option<i64>,
    dismissal_date: Option<i64>,
    relevance_score: Option<Number>,
}

fn default_priority() -> u8 {
    10
}

fn unknown_activity() -> ApiError {
    api_error(
        StatusCode::NOT_FOUND,
        "unknown_activity",
        "There is no such activity token, or it does not fit the event.",
    )
}

/// The Live Activity fields of a `liveactivity` push, refused on other kinds.
fn live_activity_fields(request: &PushBody) -> Result<Option<(String, LiveActivity)>, ApiError> {
    if request.kind != Kind::LiveActivity {
        if request.activity.is_some()
            || request.event.is_some()
            || request.timestamp.is_some()
            || request.stale_date.is_some()
            || request.dismissal_date.is_some()
            || request.relevance_score.is_some()
        {
            return Err(bad_request(
                "activity, event, timestamp, staleDate, dismissalDate and relevanceScore are only for liveactivity.",
            ));
        }
        return Ok(None);
    }
    if request.collapse_id.is_some() {
        return Err(bad_request("collapseId is not allowed for liveactivity."));
    }
    if request.priority == 1 {
        return Err(bad_request("priority must be 5 or 10 for liveactivity."));
    }
    let (Some(activity), Some(event), Some(timestamp)) = (&request.activity, request.event, request.timestamp) else {
        return Err(bad_request("liveactivity needs activity, event and timestamp."));
    };
    if [Some(timestamp), request.stale_date, request.dismissal_date]
        .into_iter()
        .flatten()
        .any(|time| time < 0)
    {
        return Err(bad_request(
            "timestamp, staleDate and dismissalDate must be Unix seconds.",
        ));
    }
    if let Some(score) = &request.relevance_score
        && !score.as_f64().is_some_and(|s| s.is_finite() && s >= 0.0)
    {
        return Err(bad_request("relevanceScore must be a number of 0 or more."));
    }
    Ok(Some((
        activity.clone(),
        LiveActivity {
            event,
            timestamp,
            stale_date: request.stale_date,
            dismissal_date: request.dismissal_date,
            relevance_score: request.relevance_score.clone(),
        },
    )))
}

/// What the sidecar signs: `hobwork-push-v1`, the timestamp, the nonce, the
/// method, the path and the SHA-256 of the body in hex, one per line.
pub fn signed_message(timestamp: &str, nonce: &str, method: &str, path: &str, body: &[u8]) -> String {
    format!(
        "hobwork-push-v1\n{timestamp}\n{nonce}\n{method}\n{path}\n{}",
        body_hash(body)
    )
}

fn bad_signature(message: &str) -> ApiError {
    api_error(StatusCode::UNAUTHORIZED, "bad_signature", message)
}

fn verify_signature(
    state: &State,
    grant: &Grant,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<(), ApiError> {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let (Some(timestamp), Some(nonce), Some(signature)) = (
        header("hobwork-timestamp"),
        header("hobwork-nonce"),
        header("hobwork-signature"),
    ) else {
        return Err(bad_signature(
            "Hobwork-Timestamp, Hobwork-Nonce and Hobwork-Signature are required.",
        ));
    };
    let now = state.now();
    let sent_at: i64 = timestamp
        .parse()
        .map_err(|_| bad_signature("Hobwork-Timestamp is not a number."))?;
    if (now - sent_at).abs() > SIGNATURE_WINDOW {
        return Err(bad_signature("Hobwork-Timestamp is more than 5 minutes off."));
    }
    if nonce.len() < 16
        || nonce.len() > 64
        || !nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(bad_signature("Hobwork-Nonce must be 16 to 64 base64url characters."));
    }
    let key = <[u8; 32]>::try_from(grant.public_key.as_slice())
        .ok()
        .and_then(|key| EdKey::from_bytes(&key).ok())
        .ok_or_else(|| bad_signature("The grant's key is unusable."))?;
    let signature = from_b64(signature)
        .and_then(|sig| <[u8; 64]>::try_from(sig).ok())
        .map(|sig| EdSignature::from_bytes(&sig))
        .ok_or_else(|| bad_signature("Hobwork-Signature is not a base64 Ed25519 signature."))?;
    let message = signed_message(timestamp, nonce, method.as_str(), uri.path(), body);
    key.verify_strict(message.as_bytes(), &signature)
        .map_err(|_| bad_signature("The signature does not match the grant's key."))?;
    if !state
        .store
        .use_request_nonce(&grant.id, nonce, now + 2 * SIGNATURE_WINDOW)?
    {
        return Err(bad_signature("The nonce was already used."));
    }
    Ok(())
}

async fn push(
    AxumState(state): AxumState<AppState>,
    ClientIp(ip): ClientIp,
    Path(grant_id): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut audit = Audit::new("push");
    audit.grant_id = Some(grant_id.clone());
    let result = send_push(&state, &grant_id, &method, &uri, &headers, &body, &mut audit).await;
    state.finish(ip, audit, result)
}

async fn send_push(
    state: &State,
    grant_id: &str,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    body: &[u8],
    audit: &mut Audit,
) -> ApiResult {
    let grant = state.store.grant(grant_id)?.ok_or_else(unknown_grant)?;
    verify_signature(state, &grant, method, uri, headers, body)?;
    audit.registration_id = Some(grant.registration_id.clone());
    let registration = state
        .store
        .registration(&grant.registration_id)?
        .ok_or_else(unknown_grant)?;
    let (Some(token), Some(environment)) = (registration.token.clone(), registration.environment) else {
        return Err(gone());
    };
    let now = state.now();
    if grant.expires_at <= now {
        return Err(expired());
    }
    if !state.limits.grant_push.check(&grant.id) || !state.limits.registration_push.check(&registration.id) {
        return Err(rate_limited());
    }

    let request: PushBody = parse_json(body)?;
    if ![1, 5, 10].contains(&request.priority) {
        return Err(bad_request("priority must be 1, 5 or 10."));
    }
    let expiration = request.expiration.unwrap_or(now + DAY);
    if expiration != 0 && (expiration < now || expiration > now + MAX_EXPIRATION) {
        return Err(bad_request(
            "expiration must be 0 or a Unix time within the next 30 days.",
        ));
    }
    if let Some(collapse_id) = &request.collapse_id
        && (collapse_id.is_empty() || collapse_id.len() > 64)
    {
        return Err(bad_request("collapseId must be 1 to 64 bytes."));
    }
    if request.key_id.is_empty() || request.key_id.len() > 64 {
        return Err(bad_request("keyId must be 1 to 64 bytes."));
    }
    if from_b64(&request.ciphertext).is_none_or(|c| c.is_empty()) {
        return Err(bad_request("ciphertext must be base64."));
    }
    let live_activity = live_activity_fields(&request)?;
    let activity_token = match &live_activity {
        Some((activity_id, activity)) => {
            let wanted = match activity.event {
                ActivityEvent::Start => ActivityKind::Start,
                ActivityEvent::Update | ActivityEvent::End => ActivityKind::Update,
            };
            let stored = state
                .store
                .activity_token(activity_id)?
                .filter(|t| t.grant_id == grant.id && t.kind == wanted && t.expires_at.is_none_or(|at| at > now))
                .ok_or_else(unknown_activity)?;
            Some(stored)
        }
        None => None,
    };
    let payload = match &live_activity {
        Some((_, activity)) => payload::live_activity(activity, &grant.id, &request.key_id, &request.ciphertext),
        None => payload::push(request.kind, &grant.id, &request.key_id, &request.ciphertext),
    }
    .to_string();
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(ApiError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            code: "too_large",
            message: format!(
                "The push would be {} bytes, and APNs allows {MAX_PAYLOAD_BYTES}.",
                payload.len()
            ),
            extra: Some(json!({ "size": payload.len(), "limit": MAX_PAYLOAD_BYTES })),
        });
    }

    let outcome = state
        .apns
        .send(&ApnsRequest {
            environment,
            token: activity_token.as_ref().map_or(token, |t| t.token.clone()),
            push_type: match request.kind {
                Kind::Background => PushType::Background,
                Kind::LiveActivity => PushType::LiveActivity,
                Kind::Alert | Kind::Command | Kind::Prompt => PushType::Alert,
            },
            // APNs refuses background pushes at a priority other than 5.
            priority: if request.kind == Kind::Background {
                5
            } else {
                request.priority
            },
            expiration,
            collapse_id: request.collapse_id,
            payload: payload.into_bytes(),
        })
        .await;
    audit.apns_status = outcome.status();
    match outcome {
        ApnsOutcome::Sent { apns_id } => Ok(ok(json!({ "apnsId": apns_id }))),
        // A gone activity token says nothing about the registration's token.
        outcome if outcome.token_gone() => match activity_token {
            Some(activity_token) => {
                state.store.delete_activity_token(&grant.id, &activity_token.id)?;
                Err(api_error(
                    StatusCode::GONE,
                    "activity_gone",
                    "The Live Activity token no longer takes pushes. Forget it.",
                ))
            }
            None => {
                state.store.mark_gone(&registration.id, now)?;
                Err(gone())
            }
        },
        outcome => Err(push_failed(&outcome)),
    }
}

/// For tests and the sidecar: the value of `Hobwork-Signature`.
pub fn sign_request(key: &ed25519_dalek::SigningKey, message: &str) -> String {
    use ed25519_dalek::Signer;
    b64(&key.sign(message.as_bytes()).to_bytes())
}
