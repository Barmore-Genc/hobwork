use std::time::Duration;

use anyhow::Result;

use crate::api::{AppState, DAY, State};
use crate::apns::{ApnsOutcome, ApnsRequest, PushType};
use crate::payload;
use crate::store::{Event, Retention};

const INTERVAL: Duration = Duration::from_secs(5 * 60);

pub const RETENTION: Retention = Retention {
    events: 14 * DAY,
    ip_key: 7 * DAY,
    unconfirmed_registration: DAY,
    expired_grant: 30 * DAY,
    gone_registration: 30 * DAY,
};

/// A random time during the next UTC day, so renewal pushes do not arrive at
/// the same time every day.
fn next_day(now: i64) -> i64 {
    (now / DAY + 1) * DAY + rand::random_range(0..DAY)
}

/// Sends one renewal push per registration with grants that were not renewed
/// in time, listing those grants.
pub async fn send_renewals(state: &State) -> Result<()> {
    let now = state.now();
    let due = state.store.due_renewals(now)?;
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    for grant in due {
        match groups.last_mut() {
            Some((registration_id, ids)) if *registration_id == grant.registration_id => ids.push(grant.id),
            _ => groups.push((grant.registration_id, vec![grant.id])),
        }
    }
    for (registration_id, grant_ids) in groups {
        let Some(registration) = state.store.registration(&registration_id)? else {
            continue;
        };
        let (Some(token), Some(environment)) = (registration.token, registration.environment) else {
            continue;
        };
        let (push_type, priority) = if registration.filtering {
            (PushType::Alert, 10)
        } else {
            (PushType::Background, 5)
        };
        let outcome = state
            .apns
            .send(&ApnsRequest {
                environment,
                token,
                push_type,
                priority,
                expiration: now + DAY,
                collapse_id: Some("hobwork-renewal".into()),
                payload: payload::renewal(&grant_ids, registration.filtering)
                    .to_string()
                    .into_bytes(),
            })
            .await;
        if outcome.token_gone() {
            state.store.mark_gone(&registration_id, now)?;
        }
        state.store.set_next_renewal_push(&grant_ids, next_day(now))?;
        state.log(&Event {
            registration_id: Some(&registration_id),
            action: "renewal_push",
            result: match outcome {
                ApnsOutcome::Sent { .. } => "ok",
                _ if outcome.token_gone() => "gone",
                _ => "push_failed",
            },
            apns_status: outcome.status(),
            ..Event::default()
        });
    }
    Ok(())
}

pub async fn run(state: AppState) {
    let mut interval = tokio::time::interval(INTERVAL);
    loop {
        interval.tick().await;
        if let Err(err) = send_renewals(&state).await {
            tracing::error!("renewal pushes failed: {err:#}");
        }
        if let Err(err) = state.store.cleanup(state.now(), &RETENTION) {
            tracing::error!("cleanup failed: {err:#}");
        }
        state.limits.prune();
    }
}
