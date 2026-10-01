use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

/// Token buckets per key, in memory: a restart refills them, which is fine for
/// limits that only need to hold over minutes to hours.
pub struct Limiter {
    capacity: f64,
    per_second: f64,
    buckets: Mutex<HashMap<String, (f64, Instant)>>,
}

impl Limiter {
    /// `capacity` requests at once, refilled at `per_hour`.
    pub fn new(capacity: u32, per_hour: u32) -> Self {
        Self {
            capacity: capacity as f64,
            per_second: per_hour as f64 / 3600.0,
            buckets: Mutex::default(),
        }
    }

    pub fn check(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut buckets = self.buckets.lock().unwrap_or_else(|p| p.into_inner());
        let (tokens, last) = buckets.entry(key.to_owned()).or_insert((self.capacity, now));
        *tokens = (*tokens + now.duration_since(*last).as_secs_f64() * self.per_second).min(self.capacity);
        *last = now;
        if *tokens >= 1.0 {
            *tokens -= 1.0;
            true
        } else {
            false
        }
    }

    /// Drops full buckets, which behave the same as missing ones.
    pub fn prune(&self) {
        let now = Instant::now();
        let mut buckets = self.buckets.lock().unwrap_or_else(|p| p.into_inner());
        buckets.retain(|_, (tokens, last)| {
            *tokens + now.duration_since(*last).as_secs_f64() * self.per_second < self.capacity
        });
    }
}

pub struct Limits {
    /// Registrations, token changes and proof pushes per client IP: each costs a push.
    pub ip_registration: Limiter,
    /// Grants and App Attest challenges per client IP.
    pub ip_grant: Limiter,
    /// Proof pushes per registration, so one registration cannot flood a device.
    pub registration_proof: Limiter,
    pub grant_push: Limiter,
    /// The ceiling per device across all of its grants.
    pub registration_push: Limiter,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            ip_registration: Limiter::new(10, 20),
            ip_grant: Limiter::new(30, 120),
            registration_proof: Limiter::new(5, 6),
            grant_push: Limiter::new(60, 600),
            registration_push: Limiter::new(120, 1200),
        }
    }
}

impl Limits {
    pub fn prune(&self) {
        for limiter in [
            &self.ip_registration,
            &self.ip_grant,
            &self.registration_proof,
            &self.grant_push,
            &self.registration_push,
        ] {
            limiter.prune();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_past_capacity() {
        let limiter = Limiter::new(2, 1);
        assert!(limiter.check("a"));
        assert!(limiter.check("a"));
        assert!(!limiter.check("a"));
        assert!(limiter.check("b"));
    }
}
