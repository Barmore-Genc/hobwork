use std::collections::VecDeque;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use ciborium::Value as Cbor;
use hobwork_relay::api::{self, AppState, DAY, State, sign_request, signed_message};
use hobwork_relay::apns::{Apns, ApnsOutcome, ApnsRequest, PushType};
use hobwork_relay::attest::Verifier;
use hobwork_relay::limits::Limits;
use hobwork_relay::store::{Environment, SqliteStore};
use hobwork_relay::tasks;
use hobwork_relay::util::{b64, random_token, sha256};
use http_body_util::BodyExt;
use p256::ecdsa::signature::Signer;
use p256::pkcs8::EncodePrivateKey;
use rcgen::{BasicConstraints, CertificateParams, CertifiedIssuer, CustomExtension, IsCa, KeyPair};
use serde_json::{Value, json};
use tower::ServiceExt;

const APP_ID: &str = "63QQLP356Q.dev.bgenc.hobwork";
const TOKEN: &str = "aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00";
const OTHER_TOKEN: &str = "bb11bb11bb11bb11bb11bb11bb11bb11bb11bb11bb11bb11bb11bb11bb11bb11";
const START: i64 = 1_790_000_000;

#[derive(Default)]
struct FakeApns {
    sent: Mutex<Vec<ApnsRequest>>,
    outcomes: Mutex<VecDeque<ApnsOutcome>>,
}

#[async_trait]
impl Apns for FakeApns {
    async fn send(&self, request: &ApnsRequest) -> ApnsOutcome {
        self.sent.lock().unwrap().push(request.clone());
        self.outcomes.lock().unwrap().pop_front().unwrap_or(ApnsOutcome::Sent {
            apns_id: Some("apns-1".into()),
        })
    }
}

impl FakeApns {
    fn last(&self) -> ApnsRequest {
        self.sent.lock().unwrap().last().cloned().expect("nothing was pushed")
    }

    fn last_payload(&self) -> Value {
        serde_json::from_slice(&self.last().payload).unwrap()
    }

    fn count(&self) -> usize {
        self.sent.lock().unwrap().len()
    }

    fn fail_next(&self, status: u16, reason: &str) {
        self.outcomes.lock().unwrap().push_back(ApnsOutcome::Refused {
            status,
            reason: reason.into(),
        });
    }
}

/// A stand-in for Apple's App Attest CA: a P-384 root and intermediate, and P-256
/// leaf keys, like Apple's.
struct TestCa {
    root_pem: String,
    intermediate: CertifiedIssuer<'static, KeyPair>,
}

impl TestCa {
    fn new() -> Self {
        let mut root_params = CertificateParams::new(vec![]).unwrap();
        root_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let root = CertifiedIssuer::self_signed(
            root_params,
            KeyPair::generate_for(&rcgen::PKCS_ECDSA_P384_SHA384).unwrap(),
        )
        .unwrap();
        let mut params = CertificateParams::new(vec![]).unwrap();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let intermediate = CertifiedIssuer::signed_by(
            params,
            KeyPair::generate_for(&rcgen::PKCS_ECDSA_P384_SHA384).unwrap(),
            &root,
        )
        .unwrap();
        Self {
            root_pem: root.pem(),
            intermediate,
        }
    }
}

struct Device {
    key: p256::ecdsa::SigningKey,
    key_id: Vec<u8>,
    counter: u32,
}

impl Device {
    fn new() -> Self {
        let mut secret = [0u8; 32];
        rand::fill(&mut secret);
        let key = p256::ecdsa::SigningKey::from_slice(&secret).unwrap();
        let public = key.verifying_key().to_sec1_point(false);
        Self {
            key_id: sha256(public.as_bytes()).to_vec(),
            key,
            counter: 0,
        }
    }

    fn attestation(&self, ca: &TestCa, app_id: &str, aaguid: &[u8; 16], challenge: &str) -> Vec<u8> {
        let mut auth_data = sha256(app_id.as_bytes()).to_vec();
        auth_data.push(0x40);
        auth_data.extend([0, 0, 0, 0]);
        auth_data.extend(aaguid);
        auth_data.extend((self.key_id.len() as u16).to_be_bytes());
        auth_data.extend(&self.key_id);
        let mut nonce_input = auth_data.clone();
        nonce_input.extend(sha256(challenge.as_bytes()));
        let nonce = sha256(&nonce_input);
        let mut extension = vec![0x30, 0x24, 0xa1, 0x22, 0x04, 0x20];
        extension.extend(nonce);

        let mut params = CertificateParams::new(vec![]).unwrap();
        params.custom_extensions.push(CustomExtension::from_oid_content(
            &[1, 2, 840, 113635, 100, 8, 2],
            extension,
        ));
        let pkcs8 = self.key.to_pkcs8_der().unwrap();
        let leaf_key = KeyPair::try_from(pkcs8.as_bytes()).unwrap();
        let leaf = params.signed_by(&leaf_key, &ca.intermediate).unwrap();

        let object = Cbor::Map(vec![
            (Cbor::Text("fmt".into()), Cbor::Text("apple-appattest".into())),
            (
                Cbor::Text("attStmt".into()),
                Cbor::Map(vec![
                    (
                        Cbor::Text("x5c".into()),
                        Cbor::Array(vec![
                            Cbor::Bytes(leaf.der().to_vec()),
                            Cbor::Bytes(ca.intermediate.der().to_vec()),
                        ]),
                    ),
                    (Cbor::Text("receipt".into()), Cbor::Bytes(vec![1, 2, 3])),
                ]),
            ),
            (Cbor::Text("authData".into()), Cbor::Bytes(auth_data)),
        ]);
        let mut out = Vec::new();
        ciborium::into_writer(&object, &mut out).unwrap();
        out
    }

    fn assertion(&mut self, method: &str, path: &str, body: &[u8]) -> String {
        self.counter += 1;
        let mut auth_data = sha256(APP_ID.as_bytes()).to_vec();
        auth_data.push(0);
        auth_data.extend(self.counter.to_be_bytes());
        let client_data = format!("{method}\n{path}\n{}", hex::encode(sha256(body)));
        let mut nonce_input = auth_data.clone();
        nonce_input.extend(sha256(client_data.as_bytes()));
        let nonce = sha256(&nonce_input);
        let signature: p256::ecdsa::Signature = self.key.sign(&nonce);
        let assertion = Cbor::Map(vec![
            (
                Cbor::Text("signature".into()),
                Cbor::Bytes(signature.to_der().as_bytes().to_vec()),
            ),
            (Cbor::Text("authenticatorData".into()), Cbor::Bytes(auth_data)),
        ]);
        let mut out = Vec::new();
        ciborium::into_writer(&assertion, &mut out).unwrap();
        b64(&out)
    }
}

struct Harness {
    app: Router,
    state: AppState,
    apns: Arc<FakeApns>,
    clock: Arc<AtomicI64>,
    ca: TestCa,
}

struct Reg {
    id: String,
    secret: String,
}

impl Harness {
    fn new() -> Self {
        let apns = Arc::new(FakeApns::default());
        let clock = Arc::new(AtomicI64::new(START));
        let ca = TestCa::new();
        let clock_read = clock.clone();
        let state = Arc::new(State {
            store: Arc::new(SqliteStore::memory().unwrap()),
            apns: apns.clone(),
            verifier: Verifier::new(APP_ID.into(), &ca.root_pem).unwrap(),
            limits: Limits::default(),
            trusted_proxies: vec![],
            clock: Arc::new(move || clock_read.load(Ordering::SeqCst)),
        });
        Self {
            app: api::router(state.clone()),
            state,
            apns,
            clock,
            ca,
        }
    }

    fn advance(&self, seconds: i64) {
        self.clock.fetch_add(seconds, Ordering::SeqCst);
    }

    fn now(&self) -> i64 {
        self.clock.load(Ordering::SeqCst)
    }

    async fn call(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<&Value>,
    ) -> (StatusCode, Value) {
        let bytes = body.map(|b| b.to_string().into_bytes()).unwrap_or_default();
        self.call_raw(method, path, headers, bytes).await
    }

    async fn call_raw(&self, method: &str, path: &str, headers: &[(&str, &str)], body: Vec<u8>) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = self
            .app
            .clone()
            .oneshot(request.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn app_call(&self, reg: &Reg, method: &str, path: &str, body: Option<&Value>) -> (StatusCode, Value) {
        let auth = format!("Bearer {}", reg.secret);
        self.call(method, path, &[("authorization", &auth)], body).await
    }

    fn proof_nonce(&self) -> String {
        self.apns.last_payload()["hobwork"]["proof"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    async fn register(&self, token: &str) -> Reg {
        let (status, body) = self
            .call(
                "POST",
                "/v1/registrations",
                &[],
                Some(&json!({ "token": token, "environment": "sandbox" })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        let reg = Reg {
            id: body["id"].as_str().unwrap().into(),
            secret: body["secret"].as_str().unwrap().into(),
        };
        let nonce = self.proof_nonce();
        let (status, body) = self
            .app_call(
                &reg,
                "POST",
                &format!("/v1/registrations/{}/proof", reg.id),
                Some(&json!({ "nonce": nonce })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        reg
    }

    async fn grant(&self, reg: &Reg, pairing: &str, key: &ed25519_dalek::SigningKey) -> String {
        let (status, body) = self
            .app_call(
                reg,
                "POST",
                &format!("/v1/registrations/{}/grants", reg.id),
                Some(&json!({ "pairing": pairing, "publicKey": b64(key.verifying_key().as_bytes()) })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        body["id"].as_str().unwrap().into()
    }

    async fn push_signed(
        &self,
        grant: &str,
        key: &ed25519_dalek::SigningKey,
        body: &Value,
        timestamp: i64,
        nonce: &str,
    ) -> (StatusCode, Value) {
        let path = format!("/v1/grants/{grant}/push");
        let bytes = body.to_string().into_bytes();
        let ts = timestamp.to_string();
        let signature = sign_request(key, &signed_message(&ts, nonce, "POST", &path, &bytes));
        self.call_raw(
            "POST",
            &path,
            &[
                ("hobwork-timestamp", &ts),
                ("hobwork-nonce", nonce),
                ("hobwork-signature", &signature),
            ],
            bytes,
        )
        .await
    }

    async fn push(&self, grant: &str, key: &ed25519_dalek::SigningKey, body: &Value) -> (StatusCode, Value) {
        self.push_signed(grant, key, body, self.now(), &random_token(16)).await
    }
}

fn sidecar_key() -> ed25519_dalek::SigningKey {
    let mut seed = [0u8; 32];
    rand::fill(&mut seed);
    ed25519_dalek::SigningKey::from_bytes(&seed)
}

fn alert() -> Value {
    json!({ "kind": "alert", "keyId": "k1", "ciphertext": b64(&[9u8; 300]), "collapseId": "c1" })
}

#[tokio::test]
async fn registration_needs_the_ownership_proof() {
    let h = Harness::new();
    let (status, body) = h
        .call(
            "POST",
            "/v1/registrations",
            &[],
            Some(&json!({ "token": TOKEN, "environment": "sandbox" })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let reg = Reg {
        id: body["id"].as_str().unwrap().into(),
        secret: body["secret"].as_str().unwrap().into(),
    };

    let proof = h.apns.last();
    assert_eq!(proof.token, TOKEN);
    assert_eq!(proof.environment, Environment::Sandbox);
    assert_eq!(proof.push_type, PushType::Alert);
    let payload = h.apns.last_payload();
    assert_eq!(payload["aps"]["mutable-content"], 1);

    let path = format!("/v1/registrations/{}", reg.id);
    let (_, body) = h.app_call(&reg, "GET", &path, None).await;
    assert_eq!(body["status"], "pending");

    let wrong = Reg {
        id: reg.id.clone(),
        secret: "nope".into(),
    };
    let (status, _) = h.app_call(&wrong, "GET", &path, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _) = h
        .app_call(
            &reg,
            "POST",
            &format!("{path}/grants"),
            Some(&json!({ "pairing": "p", "publicKey": b64(sidecar_key().verifying_key().as_bytes()) })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (status, body) = h
        .app_call(
            &reg,
            "POST",
            &format!("{path}/proof"),
            Some(&json!({ "nonce": "wrong" })),
        )
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("bad_nonce"))
    );

    h.advance(6 * 60);
    let nonce = h.proof_nonce();
    let (status, _) = h
        .app_call(&reg, "POST", &format!("{path}/proof"), Some(&json!({ "nonce": nonce })))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "the nonce expired");

    let (status, _) = h.app_call(&reg, "POST", &format!("{path}/proof-push"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let nonce = h.proof_nonce();
    let (status, _) = h
        .app_call(&reg, "POST", &format!("{path}/proof"), Some(&json!({ "nonce": nonce })))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = h.app_call(&reg, "GET", &path, None).await;
    assert_eq!(body["status"], "active");
    assert_eq!(body["environment"], "sandbox");
}

#[tokio::test]
async fn a_token_apns_refuses_is_not_registered() {
    let h = Harness::new();
    h.apns.fail_next(400, "BadDeviceToken");
    let (status, body) = h
        .call(
            "POST",
            "/v1/registrations",
            &[],
            Some(&json!({ "token": TOKEN, "environment": "production" })),
        )
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("bad_token"))
    );

    let (status, _) = h
        .call(
            "POST",
            "/v1/registrations",
            &[],
            Some(&json!({ "token": "xyz", "environment": "production" })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_token_belongs_to_one_registration() {
    let h = Harness::new();
    let first = h.register(TOKEN).await;
    let key = sidecar_key();
    let grant = h.grant(&first, "pairing-1", &key).await;
    let second = h.register(TOKEN).await;

    let (status, _) = h
        .app_call(&first, "GET", &format!("/v1/registrations/{}", first.id), None)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "the first registration was deleted");
    let (status, _) = h.push(&grant, &key, &alert()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, body) = h
        .app_call(&second, "GET", &format!("/v1/registrations/{}", second.id), None)
        .await;
    assert_eq!(body["status"], "active");
}

#[tokio::test]
async fn signed_pushes_reach_apns_with_generic_text() {
    let h = Harness::new();
    let reg = h.register(TOKEN).await;
    let key = sidecar_key();
    let grant = h.grant(&reg, "pairing-1", &key).await;

    let (status, body) = h.push(&grant, &key, &alert()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["apnsId"], "apns-1");
    let sent = h.apns.last();
    assert_eq!(sent.token, TOKEN);
    assert_eq!(sent.priority, 10);
    assert_eq!(sent.collapse_id.as_deref(), Some("c1"));
    assert_eq!(sent.expiration, h.now() + DAY);
    let payload = h.apns.last_payload();
    assert_eq!(payload["aps"]["alert"]["title"], "Hobwork");
    assert_eq!(payload["aps"]["mutable-content"], 1);
    assert_eq!(payload["hobwork"]["grant"], grant.as_str());
    assert_eq!(payload["hobwork"]["keyId"], "k1");
    assert_eq!(payload["hobwork"]["ciphertext"], b64(&[9u8; 300]));

    let command = json!({ "kind": "command", "priority": 5, "keyId": "k1", "ciphertext": "AAAA" });
    let (status, _) = h.push(&grant, &key, &command).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(h.apns.last_payload()["aps"]["interruption-level"], "passive");
    assert_eq!(h.apns.last().priority, 5);
}

#[tokio::test]
async fn background_pushes_show_nothing() {
    let h = Harness::new();
    let reg = h.register(TOKEN).await;
    let key = sidecar_key();
    let grant = h.grant(&reg, "pairing-1", &key).await;

    let background = json!({ "kind": "background", "keyId": "k1", "ciphertext": "AAAA", "collapseId": "c2" });
    let (status, body) = h.push(&grant, &key, &background).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let sent = h.apns.last();
    assert_eq!(sent.push_type, PushType::Background);
    assert_eq!(sent.priority, 5);
    let payload = h.apns.last_payload();
    assert_eq!(payload["aps"], json!({ "content-available": 1 }));
    assert_eq!(payload["hobwork"]["grant"], grant.as_str());
    assert_eq!(payload["hobwork"]["ciphertext"], "AAAA");
}

#[tokio::test]
async fn pushes_need_a_fresh_signature_from_the_grant_key() {
    let h = Harness::new();
    let reg = h.register(TOKEN).await;
    let key = sidecar_key();
    let grant = h.grant(&reg, "pairing-1", &key).await;
    let before = h.apns.count();

    let (status, _) = h.push(&grant, &sidecar_key(), &alert()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "another key");

    let (status, _) = h
        .push_signed(&grant, &key, &alert(), h.now() - 10 * 60, &random_token(16))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "stale timestamp");

    let nonce = random_token(16);
    let (status, _) = h.push_signed(&grant, &key, &alert(), h.now(), &nonce).await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = h.push_signed(&grant, &key, &alert(), h.now(), &nonce).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::UNAUTHORIZED, Some("bad_signature")),
        "replay"
    );

    let path = format!("/v1/grants/{grant}/push");
    let ts = h.now().to_string();
    let nonce = random_token(16);
    let signature = sign_request(
        &key,
        &signed_message(&ts, &nonce, "POST", &path, alert().to_string().as_bytes()),
    );
    let tampered = json!({ "kind": "prompt", "keyId": "k1", "ciphertext": b64(&[9u8; 300]), "collapseId": "c1" });
    let (status, _) = h
        .call(
            "POST",
            &path,
            &[
                ("hobwork-timestamp", &ts),
                ("hobwork-nonce", &nonce),
                ("hobwork-signature", &signature),
            ],
            Some(&tampered),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "body changed after signing");
    assert_eq!(h.apns.count(), before + 1);
}

#[tokio::test]
async fn one_grant_per_pairing_and_revocation() {
    let h = Harness::new();
    let reg = h.register(TOKEN).await;
    let key = sidecar_key();
    let old = h.grant(&reg, "pairing-1", &key).await;
    let other = h.grant(&reg, "pairing-2", &key).await;
    let new = h.grant(&reg, "pairing-1", &key).await;

    assert_eq!(h.push(&old, &key, &alert()).await.0, StatusCode::NOT_FOUND);
    assert_eq!(h.push(&new, &key, &alert()).await.0, StatusCode::OK);

    let (status, _) = h
        .app_call(
            &reg,
            "DELETE",
            &format!("/v1/registrations/{}/grants/{other}", reg.id),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(h.push(&other, &key, &alert()).await.0, StatusCode::NOT_FOUND);

    let (_, body) = h
        .app_call(&reg, "GET", &format!("/v1/registrations/{}", reg.id), None)
        .await;
    assert_eq!(body["grants"].as_array().unwrap().len(), 1);
    assert_eq!(body["grants"][0]["id"], new.as_str());
}

#[tokio::test]
async fn a_gone_token_makes_grants_gone_until_a_new_token() {
    let h = Harness::new();
    let reg = h.register(TOKEN).await;
    let key = sidecar_key();
    let grant = h.grant(&reg, "pairing-1", &key).await;

    h.apns.fail_next(410, "Unregistered");
    let (status, body) = h.push(&grant, &key, &alert()).await;
    assert_eq!((status, body["error"].as_str()), (StatusCode::GONE, Some("gone")));
    let (status, _) = h.push(&grant, &key, &alert()).await;
    assert_eq!(status, StatusCode::GONE);
    let path = format!("/v1/registrations/{}", reg.id);
    let (_, body) = h.app_call(&reg, "GET", &path, None).await;
    assert_eq!(body["status"], "gone");

    let (status, _) = h
        .app_call(
            &reg,
            "PUT",
            &path,
            Some(&json!({ "token": OTHER_TOKEN, "environment": "production" })),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let nonce = h.proof_nonce();
    h.app_call(&reg, "POST", &format!("{path}/proof"), Some(&json!({ "nonce": nonce })))
        .await;
    let (_, body) = h.app_call(&reg, "GET", &path, None).await;
    assert_eq!(body["status"], "active");
    assert_eq!(body["environment"], "production");
    assert_eq!(body["grants"], json!([]), "hosts forgot the old grants");
    assert_eq!(h.push(&grant, &key, &alert()).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn apns_failures_are_push_failed() {
    let h = Harness::new();
    let reg = h.register(TOKEN).await;
    let key = sidecar_key();
    let grant = h.grant(&reg, "pairing-1", &key).await;
    h.apns.fail_next(429, "TooManyRequests");
    let (status, body) = h.push(&grant, &key, &alert()).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body["error"], "push_failed");
    assert_eq!(body["apnsStatus"], 429);
    assert_eq!(body["reason"], "TooManyRequests");
}

#[tokio::test]
async fn oversized_and_invalid_pushes_are_refused() {
    let h = Harness::new();
    let reg = h.register(TOKEN).await;
    let key = sidecar_key();
    let grant = h.grant(&reg, "pairing-1", &key).await;
    let before = h.apns.count();

    let big = json!({ "kind": "alert", "keyId": "k1", "ciphertext": b64(&[1u8; 3000]) });
    let (status, body) = h.push(&grant, &key, &big).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::PAYLOAD_TOO_LARGE, Some("too_large"))
    );

    let late = json!({ "kind": "alert", "keyId": "k1", "ciphertext": "AAAA", "expiration": h.now() + 40 * DAY });
    assert_eq!(h.push(&grant, &key, &late).await.0, StatusCode::BAD_REQUEST);
    let unknown = json!({ "kind": "alert", "keyId": "k1", "ciphertext": "AAAA", "title": "hi" });
    assert_eq!(h.push(&grant, &key, &unknown).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(h.apns.count(), before);
}

#[tokio::test]
async fn grants_expire_and_renew() {
    let h = Harness::new();
    let reg = h.register(TOKEN).await;
    let key = sidecar_key();
    let grant = h.grant(&reg, "pairing-1", &key).await;
    let renew = format!("/v1/registrations/{}/grants/{grant}/renew", reg.id);

    h.advance(20 * DAY);
    let (status, body) = h.app_call(&reg, "POST", &renew, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["expiresAt"], h.now() + 30 * DAY);

    h.advance(29 * DAY);
    assert_eq!(h.push(&grant, &key, &alert()).await.0, StatusCode::OK);
    h.advance(2 * DAY);
    let (status, body) = h.push(&grant, &key, &alert()).await;
    assert_eq!((status, body["error"].as_str()), (StatusCode::GONE, Some("expired")));
    let (status, _) = h.app_call(&reg, "POST", &renew, None).await;
    assert_eq!(status, StatusCode::GONE);
}

#[tokio::test]
async fn renewal_pushes_go_out_once_a_day_after_day_15() {
    let h = Harness::new();
    let reg = h.register(TOKEN).await;
    let key = sidecar_key();
    let first = h.grant(&reg, "pairing-1", &key).await;
    let second = h.grant(&reg, "pairing-2", &key).await;
    let before = h.apns.count();

    h.advance(14 * DAY);
    tasks::send_renewals(&h.state).await.unwrap();
    assert_eq!(h.apns.count(), before);

    h.advance(2 * DAY);
    tasks::send_renewals(&h.state).await.unwrap();
    assert_eq!(h.apns.count(), before + 1, "one push for both grants");
    let sent = h.apns.last();
    assert_eq!(sent.push_type, PushType::Background);
    let mut renew: Vec<String> = serde_json::from_value(h.apns.last_payload()["hobwork"]["renew"].clone()).unwrap();
    renew.sort();
    let mut expected = vec![first.clone(), second];
    expected.sort();
    assert_eq!(renew, expected);

    tasks::send_renewals(&h.state).await.unwrap();
    assert_eq!(h.apns.count(), before + 1, "not again the same day");

    h.app_call(
        &reg,
        "POST",
        &format!("/v1/registrations/{}/grants/{first}/renew", reg.id),
        None,
    )
    .await;
    h.advance(2 * DAY);
    tasks::send_renewals(&h.state).await.unwrap();
    assert_eq!(h.apns.count(), before + 2);
    let renew = &h.apns.last_payload()["hobwork"]["renew"];
    assert_eq!(renew.as_array().unwrap().len(), 1, "the renewed grant is not due");
}

#[tokio::test]
async fn registrations_accept_the_filtering_field_of_older_apps() {
    let h = Harness::new();
    let body = json!({ "token": TOKEN, "environment": "sandbox", "filtering": true });
    let (status, _) = h.call("POST", "/v1/registrations", &[], Some(&body)).await;
    assert_eq!(status, StatusCode::CREATED);

    let reg = h.register(OTHER_TOKEN).await;
    let path = format!("/v1/registrations/{}", reg.id);
    let body = json!({ "token": OTHER_TOKEN, "environment": "sandbox", "filtering": true });
    let (status, _) = h.app_call(&reg, "PUT", &path, Some(&body)).await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = h.app_call(&reg, "GET", &path, None).await;
    assert!(body.get("filtering").is_none());

    h.grant(&reg, "pairing-1", &sidecar_key()).await;
    h.advance(17 * DAY);
    tasks::send_renewals(&h.state).await.unwrap();
    assert_eq!(h.apns.last().push_type, PushType::Background);
    assert_eq!(h.apns.last_payload()["aps"]["content-available"], 1);
}

#[tokio::test]
async fn attested_registrations_need_assertions() {
    let h = Harness::new();
    let mut device = Device::new();
    let (_, body) = h.call("POST", "/v1/attest/challenges", &[], None).await;
    let challenge = body["challenge"].as_str().unwrap().to_owned();
    let object = device.attestation(&h.ca, APP_ID, b"appattestdevelop", &challenge);
    let register = json!({
        "token": TOKEN,
        "environment": "sandbox",
        "attestation": { "keyId": b64(&device.key_id), "object": b64(&object), "challenge": challenge },
    });
    let (status, body) = h.call("POST", "/v1/registrations", &[], Some(&register)).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let id = body["id"].as_str().unwrap().to_owned();
    let auth = format!("Bearer {}", body["secret"].as_str().unwrap());

    let (status, _) = h.call("POST", "/v1/registrations", &[], Some(&register)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "the challenge was used");

    let path = format!("/v1/registrations/{id}/proof");
    let proof = json!({ "nonce": h.proof_nonce() });
    let (status, body) = h.call("POST", &path, &[("authorization", &auth)], Some(&proof)).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::UNAUTHORIZED, Some("assertion_required"))
    );

    let assertion = device.assertion("POST", &path, proof.to_string().as_bytes());
    let (status, body) = h
        .call(
            "POST",
            &path,
            &[("authorization", &auth), ("hobwork-assertion", &assertion)],
            Some(&proof),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let get = format!("/v1/registrations/{id}");
    let (status, _) = h
        .call(
            "GET",
            &get,
            &[("authorization", &auth), ("hobwork-assertion", &assertion)],
            None,
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "an assertion for another request");
    let fresh = device.assertion("GET", &get, b"");
    let (status, body) = h
        .call(
            "GET",
            &get,
            &[("authorization", &auth), ("hobwork-assertion", &fresh)],
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["attested"], true);
    let (status, _) = h
        .call(
            "GET",
            &get,
            &[("authorization", &auth), ("hobwork-assertion", &fresh)],
            None,
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "replayed assertion");

    let (status, body) = h
        .call(
            "POST",
            "/v1/registrations",
            &[],
            Some(&json!({ "token": TOKEN, "environment": "sandbox" })),
        )
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::CONFLICT, Some("attested_token"))
    );
}

#[tokio::test]
async fn attestations_are_checked() {
    let h = Harness::new();
    let device = Device::new();
    let attempt = |object: Vec<u8>, key_id: Vec<u8>, challenge: String, environment: &'static str| {
        json!({
            "token": TOKEN,
            "environment": environment,
            "attestation": { "keyId": b64(&key_id), "object": b64(&object), "challenge": challenge },
        })
    };
    let challenge = || async {
        h.call("POST", "/v1/attest/challenges", &[], None).await.1["challenge"]
            .as_str()
            .unwrap()
            .to_owned()
    };

    let c = challenge().await;
    let body = attempt(
        device.attestation(&h.ca, "OTHERTEAM.dev.bgenc.hobwork", b"appattestdevelop", &c),
        device.key_id.clone(),
        c,
        "sandbox",
    );
    let (status, body) = h.call("POST", "/v1/registrations", &[], Some(&body)).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("bad_attestation"))
    );

    let c = challenge().await;
    let body = attempt(
        device.attestation(&h.ca, APP_ID, b"appattestdevelop", &c),
        device.key_id.clone(),
        c,
        "production",
    );
    assert_eq!(
        h.call("POST", "/v1/registrations", &[], Some(&body)).await.0,
        StatusCode::BAD_REQUEST,
        "environment"
    );

    let c = challenge().await;
    let object = device.attestation(&h.ca, APP_ID, b"appattestdevelop", "another challenge");
    let body = attempt(object, device.key_id.clone(), c, "sandbox");
    assert_eq!(
        h.call("POST", "/v1/registrations", &[], Some(&body)).await.0,
        StatusCode::BAD_REQUEST,
        "nonce"
    );

    let c = challenge().await;
    let other_ca = TestCa::new();
    let body = attempt(
        device.attestation(&other_ca, APP_ID, b"appattestdevelop", &c),
        device.key_id.clone(),
        c,
        "sandbox",
    );
    assert_eq!(
        h.call("POST", "/v1/registrations", &[], Some(&body)).await.0,
        StatusCode::BAD_REQUEST,
        "untrusted root"
    );

    let c = challenge().await;
    let body = attempt(
        device.attestation(&h.ca, APP_ID, b"appattestdevelop", &c),
        vec![0; 32],
        c,
        "sandbox",
    );
    assert_eq!(
        h.call("POST", "/v1/registrations", &[], Some(&body)).await.0,
        StatusCode::BAD_REQUEST,
        "key ID"
    );

    let c = challenge().await;
    let body = attempt(
        device.attestation(&h.ca, APP_ID, b"appattest\0\0\0\0\0\0\0", &c),
        device.key_id.clone(),
        c,
        "production",
    );
    assert_eq!(
        h.call("POST", "/v1/registrations", &[], Some(&body)).await.0,
        StatusCode::CREATED,
        "production"
    );
}

#[tokio::test]
async fn registrations_are_rate_limited_per_ip() {
    let h = Harness::new();
    let mut statuses = Vec::new();
    for i in 0..11 {
        let token = format!("{:064x}", i + 1);
        statuses.push(
            h.call(
                "POST",
                "/v1/registrations",
                &[],
                Some(&json!({ "token": token, "environment": "sandbox" })),
            )
            .await
            .0,
        );
    }
    assert!(statuses[..10].iter().all(|s| *s == StatusCode::CREATED));
    assert_eq!(statuses[10], StatusCode::TOO_MANY_REQUESTS);
}

#[test]
fn client_ip_trusts_only_configured_proxies() {
    let proxies = hobwork_relay::config::parse_proxies("10.0.0.0/8, 127.0.0.1").unwrap();
    let ip = |s: &str| s.parse().unwrap();
    assert_eq!(
        api::client_ip(ip("203.0.113.9"), Some("1.1.1.1"), &proxies),
        ip("203.0.113.9")
    );
    assert_eq!(
        api::client_ip(ip("127.0.0.1"), Some("1.1.1.1, 10.1.2.3"), &proxies),
        ip("1.1.1.1")
    );
    assert_eq!(
        api::client_ip(ip("127.0.0.1"), Some("6.6.6.6, 1.1.1.1"), &proxies),
        ip("1.1.1.1")
    );
    assert_eq!(api::client_ip(ip("127.0.0.1"), None, &proxies), ip("127.0.0.1"));
}
