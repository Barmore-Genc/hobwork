//! APNs payloads. The relay writes every visible text itself; what hosts send
//! stays encrypted until the notification service extension opens it.

use serde::Deserialize;
use serde_json::{Value, json};

pub const TITLE: &str = "Hobwork";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Alert,
    Command,
    Prompt,
    /// Wakes the app without showing anything, for example to withdraw a
    /// notification. APNs throttles these and drops them after a force quit.
    Background,
}

/// Shown only when the notification service extension cannot open the push.
fn fallback_body(kind: Kind) -> &'static str {
    match kind {
        Kind::Alert | Kind::Background => "You have a new notification.",
        Kind::Command => "A hob sent a request to this device. Open Hobwork if it did not apply.",
        Kind::Prompt => "A hob is waiting. Tap to continue.",
    }
}

pub fn push(kind: Kind, grant_id: &str, key_id: &str, ciphertext: &str) -> Value {
    let envelope = json!({ "v": 1, "grant": grant_id, "keyId": key_id, "ciphertext": ciphertext });
    if kind == Kind::Background {
        return json!({ "aps": { "content-available": 1 }, "hobwork": envelope });
    }
    let mut aps = json!({
        "alert": { "title": TITLE, "body": fallback_body(kind) },
        "mutable-content": 1,
    });
    match kind {
        Kind::Command => aps["interruption-level"] = json!("passive"),
        Kind::Alert | Kind::Prompt => aps["sound"] = json!("default"),
        Kind::Background => unreachable!(),
    }
    json!({ "aps": aps, "hobwork": envelope })
}

/// The extension cannot hide it, so people see the text once when they set up
/// notifications.
pub fn proof(nonce: &str) -> Value {
    json!({
        "aps": {
            "alert": { "title": TITLE, "body": "Notifications from Hobwork are set up." },
            "mutable-content": 1,
            "interruption-level": "passive",
        },
        "hobwork": { "v": 1, "proof": nonce },
    })
}

/// A background push, since an alert would show its text every day.
pub fn renewal(grant_ids: &[String]) -> Value {
    json!({ "aps": { "content-available": 1 }, "hobwork": { "v": 1, "renew": grant_ids } })
}
