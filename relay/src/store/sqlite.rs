use std::path::Path;
use std::sync::Mutex;

use anyhow::{Result, bail};
use rusqlite::{Connection, OptionalExtension, Row, params};

use super::{
    ActivityKind, ActivityToken, AttestKey, ConfirmOutcome, Environment, Event, Grant, PendingToken, Registration,
    Retention, Store,
};

const MIGRATIONS: &[&str] = &[
    include_str!("../../migrations/0001_init.sql"),
    include_str!("../../migrations/0002_drop_filtering.sql"),
    include_str!("../../migrations/0003_activity_tokens.sql"),
];

pub struct SqliteStore {
    conn: Mutex<Connection>,
}

impl SqliteStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Self::init(Connection::open(path)?)
    }

    pub fn memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version as usize > MIGRATIONS.len() {
            bail!(
                "the database is at version {version}, newer than this relay ({})",
                MIGRATIONS.len()
            );
        }
        for (index, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            let tx = conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", index as i64 + 1)?;
            tx.commit()?;
        }
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

const REGISTRATION_COLUMNS: &str = "id, secret_hash, token, environment, pending_token, pending_environment,
    proof_nonce, proof_expires_at, attest_key_id, attest_public_key, attest_counter, created_at, gone_at";

fn environment(value: Option<String>) -> Option<Environment> {
    value.as_deref().and_then(Environment::parse)
}

fn registration_from_row(row: &Row) -> rusqlite::Result<Registration> {
    let pending_token: Option<String> = row.get(4)?;
    let pending_environment = environment(row.get(5)?);
    let nonce: Option<String> = row.get(6)?;
    let expires_at: Option<i64> = row.get(7)?;
    let pending = match (pending_token, pending_environment, nonce, expires_at) {
        (Some(token), Some(environment), Some(nonce), Some(expires_at)) => Some(PendingToken {
            token,
            environment,
            nonce,
            expires_at,
        }),
        _ => None,
    };
    let key_id: Option<Vec<u8>> = row.get(8)?;
    let public_key: Option<Vec<u8>> = row.get(9)?;
    let counter: Option<i64> = row.get(10)?;
    let attest = match (key_id, public_key, counter) {
        (Some(key_id), Some(public_key), Some(counter)) => Some(AttestKey {
            key_id,
            public_key,
            counter: counter as u32,
        }),
        _ => None,
    };
    Ok(Registration {
        id: row.get(0)?,
        secret_hash: row.get(1)?,
        token: row.get(2)?,
        environment: environment(row.get(3)?),
        pending,
        attest,
        created_at: row.get(11)?,
        gone_at: row.get(12)?,
    })
}

const GRANT_COLUMNS: &str =
    "id, registration_id, pairing, public_key, created_at, renewed_at, expires_at, next_renewal_push_at";

fn grant_from_row(row: &Row) -> rusqlite::Result<Grant> {
    Ok(Grant {
        id: row.get(0)?,
        registration_id: row.get(1)?,
        pairing: row.get(2)?,
        public_key: row.get(3)?,
        created_at: row.get(4)?,
        renewed_at: row.get(5)?,
        expires_at: row.get(6)?,
        next_renewal_push_at: row.get(7)?,
    })
}

const ACTIVITY_TOKEN_COLUMNS: &str = "id, grant_id, kind, token, created_at, expires_at";

fn activity_token_from_row(row: &Row) -> rusqlite::Result<ActivityToken> {
    let kind: String = row.get(2)?;
    Ok(ActivityToken {
        id: row.get(0)?,
        grant_id: row.get(1)?,
        kind: ActivityKind::parse(&kind)
            .ok_or_else(|| rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, kind.into()))?,
        token: row.get(3)?,
        created_at: row.get(4)?,
        expires_at: row.get(5)?,
    })
}

impl Store for SqliteStore {
    fn create_registration(&self, r: &Registration, now: i64) -> Result<()> {
        let pending = r.pending.as_ref();
        self.conn().execute(
            "INSERT INTO registrations (id, secret_hash, token, environment, pending_token, pending_environment,
               proof_nonce, proof_expires_at, attest_key_id, attest_public_key, attest_counter,
               created_at, last_used_at)
             VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                r.id,
                r.secret_hash,
                pending.map(|p| &p.token),
                pending.map(|p| p.environment.as_str()),
                pending.map(|p| &p.nonce),
                pending.map(|p| p.expires_at),
                r.attest.as_ref().map(|a| &a.key_id),
                r.attest.as_ref().map(|a| &a.public_key),
                r.attest.as_ref().map(|a| a.counter as i64),
                now,
                now,
            ],
        )?;
        Ok(())
    }

    fn registration(&self, id: &str) -> Result<Option<Registration>> {
        Ok(self
            .conn()
            .query_row(
                &format!("SELECT {REGISTRATION_COLUMNS} FROM registrations WHERE id = ?"),
                [id],
                registration_from_row,
            )
            .optional()?)
    }

    fn registration_by_token(&self, token: &str) -> Result<Option<Registration>> {
        Ok(self
            .conn()
            .query_row(
                &format!("SELECT {REGISTRATION_COLUMNS} FROM registrations WHERE token = ?"),
                [token],
                registration_from_row,
            )
            .optional()?)
    }

    fn delete_registration(&self, id: &str) -> Result<bool> {
        Ok(self.conn().execute("DELETE FROM registrations WHERE id = ?", [id])? > 0)
    }

    fn set_pending_token(&self, id: &str, pending: Option<&PendingToken>) -> Result<()> {
        self.conn().execute(
            "UPDATE registrations SET pending_token = ?, pending_environment = ?, proof_nonce = ?,
               proof_expires_at = ? WHERE id = ?",
            params![
                pending.map(|p| &p.token),
                pending.map(|p| p.environment.as_str()),
                pending.map(|p| &p.nonce),
                pending.map(|p| p.expires_at),
                id,
            ],
        )?;
        Ok(())
    }

    fn confirm_token(&self, id: &str, nonce: &str, now: i64) -> Result<ConfirmOutcome> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let pending: Option<(String, String, bool, Option<i64>)> = tx
            .query_row(
                "SELECT pending_token, pending_environment, attest_key_id IS NOT NULL, gone_at
                 FROM registrations WHERE id = ? AND proof_nonce = ? AND proof_expires_at > ?",
                params![id, nonce, now],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((token, environment, attested, gone_at)) = pending else {
            return Ok(ConfirmOutcome::NoMatch);
        };
        let holder: Option<(String, bool)> = tx
            .query_row(
                "SELECT id, attest_key_id IS NOT NULL FROM registrations WHERE token = ? AND id != ?",
                params![token, id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((holder_id, holder_attested)) = holder {
            if holder_attested && !attested {
                return Ok(ConfirmOutcome::AttestedConflict);
            }
            tx.execute("DELETE FROM registrations WHERE id = ?", [holder_id])?;
        }
        if gone_at.is_some() {
            tx.execute("DELETE FROM grants WHERE registration_id = ?", [id])?;
        }
        tx.execute(
            "UPDATE registrations SET token = ?, environment = ?, pending_token = NULL,
               pending_environment = NULL, proof_nonce = NULL, proof_expires_at = NULL, gone_at = NULL,
               last_used_at = ?
             WHERE id = ?",
            params![token, environment, now, id],
        )?;
        tx.commit()?;
        Ok(ConfirmOutcome::Confirmed)
    }

    fn mark_gone(&self, id: &str, now: i64) -> Result<()> {
        self.conn().execute(
            "UPDATE registrations SET token = NULL, environment = NULL, gone_at = ? WHERE id = ?",
            params![now, id],
        )?;
        Ok(())
    }

    fn touch_registration(&self, id: &str, now: i64) -> Result<()> {
        self.conn().execute(
            "UPDATE registrations SET last_used_at = ? WHERE id = ?",
            params![now, id],
        )?;
        Ok(())
    }

    fn advance_attest_counter(&self, id: &str, counter: u32) -> Result<bool> {
        Ok(self.conn().execute(
            "UPDATE registrations SET attest_counter = ? WHERE id = ? AND attest_counter < ?",
            params![counter as i64, id, counter as i64],
        )? > 0)
    }

    fn put_grant(&self, g: &Grant) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM grants WHERE registration_id = ? AND pairing = ?",
            params![g.registration_id, g.pairing],
        )?;
        tx.execute(
            &format!("INSERT INTO grants ({GRANT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
            params![
                g.id,
                g.registration_id,
                g.pairing,
                g.public_key,
                g.created_at,
                g.renewed_at,
                g.expires_at,
                g.next_renewal_push_at,
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn grant(&self, id: &str) -> Result<Option<Grant>> {
        Ok(self
            .conn()
            .query_row(
                &format!("SELECT {GRANT_COLUMNS} FROM grants WHERE id = ?"),
                [id],
                grant_from_row,
            )
            .optional()?)
    }

    fn grants(&self, registration_id: &str) -> Result<Vec<Grant>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {GRANT_COLUMNS} FROM grants WHERE registration_id = ? ORDER BY created_at, id"
        ))?;
        let rows = stmt.query_map([registration_id], grant_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn renew_grant(&self, id: &str, now: i64, expires_at: i64, next_renewal_push_at: i64) -> Result<()> {
        self.conn().execute(
            "UPDATE grants SET renewed_at = ?, expires_at = ?, next_renewal_push_at = ? WHERE id = ?",
            params![now, expires_at, next_renewal_push_at, id],
        )?;
        Ok(())
    }

    fn delete_grant(&self, registration_id: &str, id: &str) -> Result<bool> {
        Ok(self.conn().execute(
            "DELETE FROM grants WHERE id = ? AND registration_id = ?",
            params![id, registration_id],
        )? > 0)
    }

    fn due_renewals(&self, now: i64) -> Result<Vec<Grant>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT g.id, g.registration_id, g.pairing, g.public_key, g.created_at, g.renewed_at, g.expires_at,
               g.next_renewal_push_at
             FROM grants g JOIN registrations r ON r.id = g.registration_id
             WHERE g.next_renewal_push_at <= ?1 AND g.expires_at > ?1 AND r.token IS NOT NULL
             ORDER BY g.registration_id, g.id",
        )?;
        let rows = stmt.query_map([now], grant_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn set_next_renewal_push(&self, grant_ids: &[String], at: i64) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for id in grant_ids {
            tx.execute(
                "UPDATE grants SET next_renewal_push_at = ? WHERE id = ?",
                params![at, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    fn put_activity_token(&self, t: &ActivityToken, max_update: usize) -> Result<ActivityToken> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let existing = tx
            .query_row(
                &format!(
                    "SELECT {ACTIVITY_TOKEN_COLUMNS} FROM activity_tokens WHERE grant_id = ? AND kind = ? AND token = ?"
                ),
                params![t.grant_id, t.kind.as_str(), t.token],
                activity_token_from_row,
            )
            .optional()?;
        if let Some(existing) = existing {
            return Ok(existing);
        }
        if t.kind == ActivityKind::Start {
            tx.execute(
                "DELETE FROM activity_tokens WHERE grant_id = ? AND kind = 'start'",
                [&t.grant_id],
            )?;
        }
        tx.execute(
            &format!("INSERT INTO activity_tokens ({ACTIVITY_TOKEN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)"),
            params![t.id, t.grant_id, t.kind.as_str(), t.token, t.created_at, t.expires_at],
        )?;
        if t.kind == ActivityKind::Update {
            tx.execute(
                "DELETE FROM activity_tokens WHERE id IN (
                   SELECT id FROM activity_tokens WHERE grant_id = ? AND kind = 'update'
                   ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)",
                params![t.grant_id, max_update as i64],
            )?;
        }
        tx.commit()?;
        Ok(t.clone())
    }

    fn activity_token(&self, id: &str) -> Result<Option<ActivityToken>> {
        Ok(self
            .conn()
            .query_row(
                &format!("SELECT {ACTIVITY_TOKEN_COLUMNS} FROM activity_tokens WHERE id = ?"),
                [id],
                activity_token_from_row,
            )
            .optional()?)
    }

    fn delete_activity_token(&self, grant_id: &str, id: &str) -> Result<bool> {
        Ok(self.conn().execute(
            "DELETE FROM activity_tokens WHERE id = ? AND grant_id = ?",
            params![id, grant_id],
        )? > 0)
    }

    fn use_request_nonce(&self, grant_id: &str, nonce: &str, expires_at: i64) -> Result<bool> {
        Ok(self.conn().execute(
            "INSERT INTO request_nonces (grant_id, nonce, expires_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
            params![grant_id, nonce, expires_at],
        )? > 0)
    }

    fn create_attest_challenge(&self, challenge: &str, expires_at: i64) -> Result<()> {
        self.conn().execute(
            "INSERT INTO attest_challenges (challenge, expires_at) VALUES (?, ?)",
            params![challenge, expires_at],
        )?;
        Ok(())
    }

    fn take_attest_challenge(&self, challenge: &str, now: i64) -> Result<bool> {
        Ok(self.conn().execute(
            "DELETE FROM attest_challenges WHERE challenge = ? AND expires_at > ?",
            params![challenge, now],
        )? > 0)
    }

    fn ip_key(&self, now: i64, max_age: i64) -> Result<Vec<u8>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM ip_keys WHERE created_at <= ?", [now - max_age])?;
        let existing: Option<Vec<u8>> = tx
            .query_row("SELECT key FROM ip_keys ORDER BY created_at DESC LIMIT 1", [], |row| {
                row.get(0)
            })
            .optional()?;
        let key = match existing {
            Some(key) => key,
            None => {
                let mut key = vec![0u8; 32];
                rand::fill(&mut key[..]);
                tx.execute("INSERT INTO ip_keys (key, created_at) VALUES (?, ?)", params![key, now])?;
                key
            }
        };
        tx.commit()?;
        Ok(key)
    }

    fn log(&self, e: &Event, now: i64) -> Result<()> {
        self.conn().execute(
            "INSERT INTO events (at, ip_hash, registration_id, grant_id, action, result, apns_status)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                now,
                e.ip_hash,
                e.registration_id,
                e.grant_id,
                e.action,
                e.result,
                e.apns_status
            ],
        )?;
        Ok(())
    }

    fn cleanup(&self, now: i64, retention: &Retention) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM events WHERE at <= ?", [now - retention.events])?;
        tx.execute("DELETE FROM ip_keys WHERE created_at <= ?", [now - retention.ip_key])?;
        tx.execute("DELETE FROM request_nonces WHERE expires_at <= ?", [now])?;
        tx.execute("DELETE FROM attest_challenges WHERE expires_at <= ?", [now])?;
        tx.execute("DELETE FROM activity_tokens WHERE expires_at <= ?", [now])?;
        tx.execute(
            "DELETE FROM registrations WHERE token IS NULL AND gone_at IS NULL AND created_at <= ?",
            [now - retention.unconfirmed_registration],
        )?;
        tx.execute(
            "DELETE FROM registrations WHERE gone_at IS NOT NULL AND gone_at <= ?",
            [now - retention.gone_registration],
        )?;
        tx.execute(
            "DELETE FROM grants WHERE expires_at <= ?",
            [now - retention.expired_grant],
        )?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ip_keys_are_replaced_after_max_age() {
        let store = SqliteStore::memory().unwrap();
        let first = store.ip_key(1000, 100).unwrap();
        assert_eq!(store.ip_key(1099, 100).unwrap(), first);
        let second = store.ip_key(1100, 100).unwrap();
        assert_ne!(second, first);
        let count: i64 = store
            .conn()
            .query_row("SELECT count(*) FROM ip_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "the old key is gone");
    }

    #[test]
    fn cleanup_drops_old_events_and_unconfirmed_registrations() {
        let store = SqliteStore::memory().unwrap();
        let retention = Retention {
            events: 10,
            ip_key: 10,
            unconfirmed_registration: 10,
            expired_grant: 10,
            gone_registration: 10,
        };
        store
            .log(
                &Event {
                    action: "push",
                    result: "ok",
                    ..Event::default()
                },
                0,
            )
            .unwrap();
        store
            .log(
                &Event {
                    action: "push",
                    result: "ok",
                    ..Event::default()
                },
                15,
            )
            .unwrap();
        let registration = Registration {
            id: "r".into(),
            secret_hash: vec![0; 32],
            token: None,
            environment: None,
            pending: None,
            attest: None,
            created_at: 0,
            gone_at: None,
        };
        store.create_registration(&registration, 0).unwrap();
        store.cleanup(20, &retention).unwrap();
        let events: i64 = store
            .conn()
            .query_row("SELECT count(*) FROM events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(events, 1);
        assert!(store.registration("r").unwrap().is_none());
    }

    fn store_with_grant() -> SqliteStore {
        let store = SqliteStore::memory().unwrap();
        let registration = Registration {
            id: "r".into(),
            secret_hash: vec![0; 32],
            token: None,
            environment: None,
            pending: None,
            attest: None,
            created_at: 0,
            gone_at: None,
        };
        store.create_registration(&registration, 0).unwrap();
        store
            .put_grant(&Grant {
                id: "g".into(),
                registration_id: "r".into(),
                pairing: "p".into(),
                public_key: vec![0; 32],
                created_at: 0,
                renewed_at: 0,
                expires_at: 100,
                next_renewal_push_at: 100,
            })
            .unwrap();
        store
    }

    fn update_token(id: &str, token: &str, created_at: i64) -> ActivityToken {
        ActivityToken {
            id: id.into(),
            grant_id: "g".into(),
            kind: ActivityKind::Update,
            token: token.into(),
            created_at,
            expires_at: Some(created_at + 10),
        }
    }

    #[test]
    fn update_tokens_are_trimmed_oldest_first() {
        let store = store_with_grant();
        store.put_activity_token(&update_token("a", "aa", 1), 2).unwrap();
        store.put_activity_token(&update_token("b", "bb", 2), 2).unwrap();
        store.put_activity_token(&update_token("c", "cc", 2), 2).unwrap();
        assert!(store.activity_token("a").unwrap().is_none());
        assert!(store.activity_token("b").unwrap().is_some());
        assert!(store.activity_token("c").unwrap().is_some());
    }

    #[test]
    fn expired_activity_tokens_are_cleaned_up_and_go_with_their_grant() {
        let store = store_with_grant();
        let retention = Retention {
            events: 10,
            ip_key: 10,
            unconfirmed_registration: 1000,
            expired_grant: 1000,
            gone_registration: 1000,
        };
        store.put_activity_token(&update_token("a", "aa", 0), 16).unwrap();
        store.put_activity_token(&update_token("b", "bb", 5), 16).unwrap();
        store.cleanup(10, &retention).unwrap();
        assert!(store.activity_token("a").unwrap().is_none());
        assert!(store.activity_token("b").unwrap().is_some());
        store.delete_grant("r", "g").unwrap();
        assert!(store.activity_token("b").unwrap().is_none());
    }
}
