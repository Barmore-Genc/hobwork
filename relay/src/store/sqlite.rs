use std::path::Path;
use std::sync::Mutex;

use anyhow::{Result, bail};
use rusqlite::{Connection, OptionalExtension, Row, params};

use super::{AttestKey, ConfirmOutcome, Environment, Event, Grant, PendingToken, Registration, Retention, Store};

const MIGRATIONS: &[&str] = &[include_str!("../../migrations/0001_init.sql")];

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
    proof_nonce, proof_expires_at, filtering, attest_key_id, attest_public_key, attest_counter,
    created_at, gone_at";

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
    let key_id: Option<Vec<u8>> = row.get(9)?;
    let public_key: Option<Vec<u8>> = row.get(10)?;
    let counter: Option<i64> = row.get(11)?;
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
        filtering: row.get(8)?,
        attest,
        created_at: row.get(12)?,
        gone_at: row.get(13)?,
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

impl Store for SqliteStore {
    fn create_registration(&self, r: &Registration, now: i64) -> Result<()> {
        let pending = r.pending.as_ref();
        self.conn().execute(
            "INSERT INTO registrations (id, secret_hash, token, environment, pending_token, pending_environment,
               proof_nonce, proof_expires_at, filtering, attest_key_id, attest_public_key, attest_counter,
               created_at, last_used_at)
             VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                r.id,
                r.secret_hash,
                pending.map(|p| &p.token),
                pending.map(|p| p.environment.as_str()),
                pending.map(|p| &p.nonce),
                pending.map(|p| p.expires_at),
                r.filtering,
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

    fn set_filtering(&self, id: &str, filtering: bool) -> Result<()> {
        self.conn().execute(
            "UPDATE registrations SET filtering = ? WHERE id = ?",
            params![filtering, id],
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
            filtering: false,
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
}
