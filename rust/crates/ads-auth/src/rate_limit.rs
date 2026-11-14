use std::collections::HashMap;
use std::time::{Duration, Instant};

pub const DEFAULT_MAX_ATTEMPTS: u32 = 5;
pub const DEFAULT_BASE_LOCKOUT: Duration = Duration::from_secs(5 * 60);
pub const DEFAULT_MAX_ENTRIES: usize = 50_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LockState {
    pub locked: bool,
    pub retry_after: Duration,
}

#[derive(Debug)]
struct AttemptRecord {
    failures: u32,
    lock_level: u32,
    locked_until: Option<Instant>,
}

pub struct LoginRateLimiter {
    max_attempts: u32,
    base_lockout: Duration,
    max_lockout: Duration,
    max_entries: usize,
    records: HashMap<String, AttemptRecord>,
}

impl LoginRateLimiter {
    pub fn new(max_attempts: u32, base_lockout: Duration) -> Self {
        let base_lockout = base_lockout.max(Duration::from_secs(1));
        Self {
            max_attempts: max_attempts.max(1),
            base_lockout,
            max_lockout: base_lockout.saturating_mul(12),
            max_entries: DEFAULT_MAX_ENTRIES,
            records: HashMap::new(),
        }
    }

    pub fn check(&self, keys: &[String]) -> LockState {
        let now = Instant::now();
        let retry_after = keys
            .iter()
            .filter(|key| !key.trim().is_empty())
            .filter_map(|key| self.records.get(key))
            .filter_map(|record| record.locked_until)
            .map(|locked_until| locked_until.saturating_duration_since(now))
            .max()
            .unwrap_or_default();

        LockState {
            locked: !retry_after.is_zero(),
            retry_after,
        }
    }

    pub fn record_failure(&mut self, keys: &[String]) {
        let now = Instant::now();
        self.prune_if_needed(now);

        for key in keys {
            let key = key.trim();
            if key.is_empty() {
                continue;
            }

            let record = self
                .records
                .entry(key.to_string())
                .or_insert(AttemptRecord {
                    failures: 0,
                    lock_level: 0,
                    locked_until: None,
                });
            if record
                .locked_until
                .is_some_and(|locked_until| locked_until > now)
            {
                continue;
            }

            record.failures += 1;
            if record.failures >= self.max_attempts {
                let multiplier = 1_u32 << record.lock_level.min(20);
                let duration = self
                    .base_lockout
                    .saturating_mul(multiplier)
                    .min(self.max_lockout);
                record.locked_until = now.checked_add(duration);
                record.lock_level += 1;
                record.failures = 0;
            }
        }
    }

    pub fn record_success(&mut self, keys: &[String]) {
        for key in keys {
            self.records.remove(key.trim());
        }
    }

    fn prune_if_needed(&mut self, now: Instant) {
        if self.records.len() < self.max_entries {
            return;
        }
        self.records.retain(|_, record| {
            record
                .locked_until
                .is_some_and(|locked_until| locked_until > now)
        });
    }
}

pub fn build_login_rate_limit_keys(username: &str, ip: Option<&str>) -> Vec<String> {
    let mut keys = Vec::with_capacity(2);
    let normalized_username = username.trim().to_lowercase();
    if !normalized_username.is_empty() {
        keys.push(format!("u:{normalized_username}"));
    }
    if let Some(ip) = ip.map(str::trim).filter(|value| !value.is_empty()) {
        keys.push(format!("ip:{ip}"));
    }
    keys
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{LoginRateLimiter, build_login_rate_limit_keys};

    #[test]
    fn locks_after_configured_failures() {
        let mut limiter = LoginRateLimiter::new(2, Duration::from_secs(1));
        let keys = build_login_rate_limit_keys("ADMIN", Some("127.0.0.1"));
        assert!(!limiter.check(&keys).locked);
        limiter.record_failure(&keys);
        assert!(!limiter.check(&keys).locked);
        limiter.record_failure(&keys);
        assert!(limiter.check(&keys).locked);
    }
}
