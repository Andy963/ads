use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimitDecision {
    pub allowed: bool,
    pub reset_at: Instant,
}

#[derive(Debug, Clone, Copy)]
struct RateLimitRecord {
    count: u32,
    reset_at: Instant,
}

pub struct InMemoryRateLimiter {
    max_requests: u32,
    window: Duration,
    sweep_interval: Duration,
    next_sweep_at: Option<Instant>,
    request_counts: HashMap<i64, RateLimitRecord>,
}

impl InMemoryRateLimiter {
    pub fn new(max_requests: u32, window: Duration, sweep_interval: Duration) -> Self {
        Self {
            max_requests: max_requests.max(1),
            window,
            sweep_interval,
            next_sweep_at: None,
            request_counts: HashMap::new(),
        }
    }

    pub fn consume(&mut self, user_id: i64, now: Instant) -> RateLimitDecision {
        if self.sweep_interval > Duration::ZERO
            && self
                .next_sweep_at
                .is_none_or(|next_sweep| now >= next_sweep)
        {
            self.request_counts
                .retain(|_, record| record.reset_at >= now);
            self.next_sweep_at = Some(now + self.sweep_interval);
        }

        if let Some(record) = self.request_counts.get_mut(&user_id) {
            if now <= record.reset_at {
                if record.count >= self.max_requests {
                    return RateLimitDecision {
                        allowed: false,
                        reset_at: record.reset_at,
                    };
                }
                record.count += 1;
                return RateLimitDecision {
                    allowed: true,
                    reset_at: record.reset_at,
                };
            }
        }

        let reset_at = now + self.window;
        self.request_counts
            .insert(user_id, RateLimitRecord { count: 1, reset_at });
        RateLimitDecision {
            allowed: true,
            reset_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_each_user_and_recovers_after_the_window() {
        let start = Instant::now();
        let mut limiter =
            InMemoryRateLimiter::new(2, Duration::from_secs(60), Duration::from_secs(60));
        assert!(limiter.consume(1, start).allowed);
        assert!(limiter.consume(1, start).allowed);
        assert!(!limiter.consume(1, start).allowed);
        assert!(limiter.consume(2, start).allowed);
        assert!(limiter.consume(1, start + Duration::from_secs(61)).allowed);
    }
}
