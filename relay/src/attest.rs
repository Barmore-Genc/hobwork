//! App Attest: attestations when a registration is created, assertions on
//! every later call. See Apple's "Validating apps that connect to your server".

use ciborium::Value;
use sha2::{Digest, Sha256, Sha384};
use x509_cert::Certificate;
use x509_cert::der::{Decode, Encode, oid::ObjectIdentifier};

use crate::store::Environment;
use crate::util::sha256;

pub const APPLE_ROOT_PEM: &str = include_str!("../certs/apple-app-attestation-root-ca.pem");

const NONCE_EXTENSION: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113635.100.8.2");
const ECDSA_SHA256: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.10045.4.3.2");
const ECDSA_SHA384: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.10045.4.3.3");
const P256: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.10045.3.1.7");
const P384: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.3.132.0.34");
const AAGUID_DEVELOPMENT: &[u8; 16] = b"appattestdevelop";
const AAGUID_PRODUCTION: &[u8; 16] = b"appattest\0\0\0\0\0\0\0";

#[derive(Debug, PartialEq, Eq)]
pub struct AttestError(pub &'static str);

impl std::fmt::Display for AttestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

pub struct Verifier {
    pub app_id: String,
    root: Certificate,
}

pub struct AttestedKey {
    pub key_id: Vec<u8>,
    /// Uncompressed SEC1 P-256 point.
    pub public_key: Vec<u8>,
}

fn err<T>(message: &'static str) -> Result<T, AttestError> {
    Err(AttestError(message))
}

fn map_get<'a>(map: &'a [(Value, Value)], key: &str) -> Option<&'a Value> {
    map.iter().find(|(k, _)| k.as_text() == Some(key)).map(|(_, v)| v)
}

fn map_bytes<'a>(map: &'a [(Value, Value)], key: &str) -> Option<&'a Vec<u8>> {
    map_get(map, key).and_then(Value::as_bytes)
}

/// Reads one DER TLV and returns (tag, contents, rest). Only definite lengths.
fn der_tlv(input: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, rest) = input.split_first()?;
    let (&first, rest) = rest.split_first()?;
    let (len, rest) = if first < 0x80 {
        (first as usize, rest)
    } else {
        let count = (first & 0x7f) as usize;
        if count == 0 || count > 4 || rest.len() < count {
            return None;
        }
        let len = rest[..count].iter().fold(0usize, |acc, b| (acc << 8) | *b as usize);
        (len, &rest[count..])
    };
    if rest.len() < len {
        return None;
    }
    Some((tag, &rest[..len], &rest[len..]))
}

/// The nonce extension is `SEQUENCE { [1] EXPLICIT OCTET STRING }`.
fn nonce_from_extension(value: &[u8]) -> Option<&[u8]> {
    let (0x30, seq, _) = der_tlv(value)? else { return None };
    let (0xa1, tagged, _) = der_tlv(seq)? else { return None };
    let (0x04, octets, _) = der_tlv(tagged)? else {
        return None;
    };
    Some(octets)
}

fn verify_signed_by(cert: &Certificate, issuer: &Certificate) -> Result<(), AttestError> {
    let tbs = cert
        .tbs_certificate()
        .to_der()
        .or(err("certificate cannot be encoded"))?;
    let digest: Vec<u8> = match cert.signature_algorithm().oid {
        ECDSA_SHA256 => Sha256::digest(&tbs).to_vec(),
        ECDSA_SHA384 => Sha384::digest(&tbs).to_vec(),
        _ => return err("certificate signature algorithm is not ECDSA"),
    };
    let signature = cert
        .signature()
        .as_bytes()
        .ok_or(AttestError("certificate signature is malformed"))?;
    let spki = issuer.tbs_certificate().subject_public_key_info();
    let curve = spki
        .algorithm
        .parameters
        .as_ref()
        .and_then(|p| p.decode_as::<ObjectIdentifier>().ok())
        .ok_or(AttestError("issuer key has no curve"))?;
    let key = spki
        .subject_public_key
        .as_bytes()
        .ok_or(AttestError("issuer key is malformed"))?;
    use p256::ecdsa::signature::hazmat::PrehashVerifier;
    let valid = match curve {
        P256 => {
            let key = p256::ecdsa::VerifyingKey::from_sec1_bytes(key).or(err("issuer key is malformed"))?;
            let sig = p256::ecdsa::Signature::from_der(signature).or(err("certificate signature is malformed"))?;
            key.verify_prehash(&digest, &sig).is_ok()
        }
        P384 => {
            let key = p384::ecdsa::VerifyingKey::from_sec1_bytes(key).or(err("issuer key is malformed"))?;
            let sig = p384::ecdsa::Signature::from_der(signature).or(err("certificate signature is malformed"))?;
            key.verify_prehash(&digest, &sig).is_ok()
        }
        _ => return err("issuer key curve is not supported"),
    };
    if valid {
        Ok(())
    } else {
        err("certificate chain does not lead to the App Attest root")
    }
}

fn check_validity(cert: &Certificate, now: i64) -> Result<(), AttestError> {
    let validity = cert.tbs_certificate().validity();
    let not_before = validity.not_before.to_unix_duration().as_secs() as i64;
    let not_after = validity.not_after.to_unix_duration().as_secs() as i64;
    if now < not_before || now > not_after {
        return err("certificate is not valid now");
    }
    Ok(())
}

impl Verifier {
    pub fn new(app_id: String, root_pem: &str) -> anyhow::Result<Self> {
        let root = Certificate::load_pem_chain(root_pem.as_bytes())?
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("no App Attest root certificate"))?;
        Ok(Self { app_id, root })
    }

    /// Checks an attestation object for `key_id`. `client_data_hash` is what the
    /// app passed to `attestKey`.
    pub fn verify_attestation(
        &self,
        object: &[u8],
        key_id: &[u8],
        client_data_hash: &[u8; 32],
        environment: Environment,
        now: i64,
    ) -> Result<AttestedKey, AttestError> {
        let value: Value = ciborium::from_reader(object).or(err("attestation is not CBOR"))?;
        let map = value.as_map().ok_or(AttestError("attestation is not a map"))?;
        if map_get(map, "fmt").and_then(Value::as_text) != Some("apple-appattest") {
            return err("attestation format is not apple-appattest");
        }
        let statement = map_get(map, "attStmt")
            .and_then(Value::as_map)
            .ok_or(AttestError("attestation has no attStmt"))?;
        let auth_data = map_bytes(map, "authData").ok_or(AttestError("attestation has no authData"))?;
        let x5c = map_get(statement, "x5c")
            .and_then(Value::as_array)
            .ok_or(AttestError("attestation has no x5c"))?;
        let [leaf, intermediate] = x5c.as_slice() else {
            return err("x5c does not hold two certificates");
        };
        let leaf = Certificate::from_der(leaf.as_bytes().ok_or(AttestError("x5c entry is not bytes"))?)
            .or(err("leaf certificate is malformed"))?;
        let intermediate = Certificate::from_der(intermediate.as_bytes().ok_or(AttestError("x5c entry is not bytes"))?)
            .or(err("intermediate certificate is malformed"))?;

        verify_signed_by(&intermediate, &self.root)?;
        verify_signed_by(&leaf, &intermediate)?;
        check_validity(&intermediate, now)?;
        check_validity(&leaf, now)?;

        let mut hasher = Sha256::new();
        hasher.update(auth_data);
        hasher.update(client_data_hash);
        let nonce = hasher.finalize();
        let extension = leaf
            .tbs_certificate()
            .extensions()
            .and_then(|exts| exts.iter().find(|e| e.extn_id == NONCE_EXTENSION))
            .ok_or(AttestError("leaf certificate has no nonce"))?;
        let found = nonce_from_extension(extension.extn_value.as_bytes()).ok_or(AttestError("nonce is malformed"))?;
        if found != nonce.as_slice() {
            return err("nonce does not match");
        }

        let public_key = leaf
            .tbs_certificate()
            .subject_public_key_info()
            .subject_public_key
            .as_bytes()
            .ok_or(AttestError("leaf key is malformed"))?
            .to_vec();
        if sha256(&public_key) != key_id {
            return err("key ID does not match the certificate");
        }

        if auth_data.len() < 55 {
            return err("authData is too short");
        }
        if auth_data[..32] != sha256(self.app_id.as_bytes()) {
            return err("attestation is for another app");
        }
        if auth_data[33..37] != [0, 0, 0, 0] {
            return err("attestation counter is not zero");
        }
        let expected_aaguid = match environment {
            Environment::Sandbox => AAGUID_DEVELOPMENT,
            Environment::Production => AAGUID_PRODUCTION,
        };
        if &auth_data[37..53] != expected_aaguid {
            return err("attestation environment does not match");
        }
        let id_len = u16::from_be_bytes([auth_data[53], auth_data[54]]) as usize;
        if auth_data.get(55..55 + id_len) != Some(key_id) {
            return err("credential ID does not match the key ID");
        }
        Ok(AttestedKey {
            key_id: key_id.to_vec(),
            public_key,
        })
    }

    /// Checks an assertion over `client_data` and returns its counter, which the
    /// caller must store only if it is above the last one.
    pub fn verify_assertion(
        &self,
        assertion: &[u8],
        client_data: &[u8],
        public_key: &[u8],
    ) -> Result<u32, AttestError> {
        let value: Value = ciborium::from_reader(assertion).or(err("assertion is not CBOR"))?;
        let map = value.as_map().ok_or(AttestError("assertion is not a map"))?;
        let signature = map_bytes(map, "signature").ok_or(AttestError("assertion has no signature"))?;
        let auth_data = map_bytes(map, "authenticatorData").ok_or(AttestError("assertion has no authenticatorData"))?;
        if auth_data.len() < 37 {
            return err("authenticatorData is too short");
        }
        let mut hasher = Sha256::new();
        hasher.update(auth_data);
        hasher.update(sha256(client_data));
        let nonce = hasher.finalize();
        let key = p256::ecdsa::VerifyingKey::from_sec1_bytes(public_key).or(err("stored key is malformed"))?;
        let signature = p256::ecdsa::Signature::from_der(signature).or(err("assertion signature is malformed"))?;
        use p256::ecdsa::signature::Verifier as _;
        key.verify(&nonce, &signature)
            .or(err("assertion signature does not verify"))?;
        if auth_data[..32] != sha256(self.app_id.as_bytes()) {
            return err("assertion is for another app");
        }
        Ok(u32::from_be_bytes([
            auth_data[33],
            auth_data[34],
            auth_data[35],
            auth_data[36],
        ]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apple_root_loads() {
        Verifier::new("63QQLP356Q.dev.bgenc.hobwork".into(), APPLE_ROOT_PEM).unwrap();
    }

    #[test]
    fn nonce_extension_parses() {
        let mut value = vec![0x30, 0x24, 0xa1, 0x22, 0x04, 0x20];
        value.extend([7u8; 32]);
        assert_eq!(nonce_from_extension(&value), Some(&[7u8; 32][..]));
        assert_eq!(nonce_from_extension(&value[..10]), None);
    }
}
