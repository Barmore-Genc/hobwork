//! APNs payloads. The relay writes every visible text itself; what hosts send
//! stays encrypted until the notification service extension opens it.

use serde::Deserialize;
use serde_json::{Number, Value, json};

pub const TITLE: &str = "Hobwork";
/// ActivityKit finds the attributes type by this name, so it must match the app's.
pub const ACTIVITY_ATTRIBUTES_TYPE: &str = "HobworkActivityAttributes";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Alert,
    Command,
    Prompt,
    /// Wakes the app without showing anything, for example to withdraw a
    /// notification. APNs throttles these and drops them after a force quit.
    Background,
    /// Starts, updates or ends a Live Activity through an ActivityKit token.
    LiveActivity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityEvent {
    Start,
    Update,
    End,
}

impl ActivityEvent {
    pub fn as_str(self) -> &'static str {
        match self {
            ActivityEvent::Start => "start",
            ActivityEvent::Update => "update",
            ActivityEvent::End => "end",
        }
    }
}

#[derive(Debug, Clone)]
pub struct LiveActivity {
    pub event: ActivityEvent,
    pub timestamp: i64,
    pub stale_date: Option<i64>,
    pub dismissal_date: Option<i64>,
    pub relevance_score: Option<Number>,
}

/// Shown only when the notification service extension cannot open the push.
/// For a Live Activity it is the alert that comes with a push-to-start.
fn fallback_body(kind: Kind) -> &'static str {
    match kind {
        Kind::Alert | Kind::Background => "You have a new notification.",
        Kind::Command => "A hob sent a request to this device. Open Hobwork if it did not apply.",
        Kind::Prompt => "A hob is waiting. Tap to continue.",
        Kind::LiveActivity => "A hob started a Live Activity.",
    }
}

fn envelope(grant_id: &str, key_id: &str, ciphertext: &str) -> Value {
    json!({ "v": 1, "grant": grant_id, "keyId": key_id, "ciphertext": ciphertext })
}

pub fn push(kind: Kind, grant_id: &str, key_id: &str, ciphertext: &str) -> Value {
    let envelope = envelope(grant_id, key_id, ciphertext);
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
        Kind::Background | Kind::LiveActivity => unreachable!(),
    }
    json!({ "aps": aps, "hobwork": envelope })
}

/// ActivityKit decodes the content state, and on start the attributes, without
/// running app code first, so the app's decoders open the envelope themselves.
pub fn live_activity(activity: &LiveActivity, grant_id: &str, key_id: &str, ciphertext: &str) -> Value {
    let envelope = envelope(grant_id, key_id, ciphertext);
    let mut aps = json!({
        "timestamp": activity.timestamp,
        "event": activity.event.as_str(),
        "content-state": { "hobwork": envelope },
    });
    if let Some(stale_date) = activity.stale_date {
        aps["stale-date"] = json!(stale_date);
    }
    if let Some(dismissal_date) = activity.dismissal_date {
        aps["dismissal-date"] = json!(dismissal_date);
    }
    if let Some(relevance_score) = &activity.relevance_score {
        aps["relevance-score"] = json!(relevance_score);
    }
    if activity.event == ActivityEvent::Start {
        aps["attributes-type"] = json!(ACTIVITY_ATTRIBUTES_TYPE);
        aps["attributes"] = json!({ "hobwork": envelope });
        aps["alert"] = json!({ "title": TITLE, "body": fallback_body(Kind::LiveActivity) });
        aps["input-push-token"] = json!(1);
    }
    json!({ "aps": aps })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn activity(event: ActivityEvent) -> LiveActivity {
        LiveActivity {
            event,
            timestamp: 1_790_000_000,
            stale_date: None,
            dismissal_date: None,
            relevance_score: None,
        }
    }

    #[test]
    fn live_activity_updates_carry_the_envelope_as_content_state() {
        let payload = live_activity(&activity(ActivityEvent::Update), "g", "k", "AAAA");
        let envelope = json!({ "v": 1, "grant": "g", "keyId": "k", "ciphertext": "AAAA" });
        assert_eq!(
            payload,
            json!({ "aps": {
                "timestamp": 1_790_000_000,
                "event": "update",
                "content-state": { "hobwork": envelope },
            } })
        );
    }

    #[test]
    fn live_activity_starts_name_the_attributes_and_ask_for_a_token() {
        let mut start = activity(ActivityEvent::Start);
        start.stale_date = Some(1_790_000_600);
        start.dismissal_date = Some(1_790_001_000);
        start.relevance_score = Number::from_f64(50.5);
        let payload = live_activity(&start, "g", "k", "AAAA");
        let envelope = json!({ "v": 1, "grant": "g", "keyId": "k", "ciphertext": "AAAA" });
        assert_eq!(
            payload,
            json!({ "aps": {
                "timestamp": 1_790_000_000,
                "event": "start",
                "content-state": { "hobwork": envelope },
                "stale-date": 1_790_000_600,
                "dismissal-date": 1_790_001_000,
                "relevance-score": 50.5,
                "attributes-type": "HobworkActivityAttributes",
                "attributes": { "hobwork": envelope },
                "alert": { "title": "Hobwork", "body": "A hob started a Live Activity." },
                "input-push-token": 1,
            } })
        );
    }

    #[test]
    fn relevance_scores_keep_the_form_the_host_sent() {
        let mut update = activity(ActivityEvent::Update);
        for score in ["50", "50.5", "0"] {
            update.relevance_score = Some(serde_json::from_str(score).unwrap());
            let payload = live_activity(&update, "g", "k", "AAAA");
            assert_eq!(payload["aps"]["relevance-score"].to_string(), score);
        }
    }
}
