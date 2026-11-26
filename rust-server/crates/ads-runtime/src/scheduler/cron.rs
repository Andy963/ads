use std::collections::BTreeSet;

use chrono::{
    Datelike, Duration as ChronoDuration, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Timelike,
};
use chrono_tz::Tz;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCron {
    pub minutes: Vec<u32>,
    pub hours: Vec<u32>,
    pub weekdays: Option<BTreeSet<u32>>,
}

pub fn validate_time_zone(timezone: &str) -> Result<(), String> {
    let timezone = timezone.trim();
    if timezone.is_empty() {
        return Err("timezone is required".to_string());
    }
    timezone
        .parse::<Tz>()
        .map(|_| ())
        .map_err(|_| format!("Invalid time zone: {timezone}"))
}

pub fn parse_supported_cron(cron: &str) -> Result<ParsedCron, String> {
    let raw = cron.trim();
    if raw.is_empty() {
        return Err("cron is required".to_string());
    }
    let parts = raw.split_whitespace().collect::<Vec<_>>();
    if parts.len() != 5 {
        return Err(format!("cron must have 5 fields, got {}", parts.len()));
    }
    let (minute_field, hour_field, dom_field, month_field, dow_field) =
        (parts[0], parts[1], parts[2], parts[3], parts[4]);
    if dom_field != "*" || month_field != "*" {
        return Err("Only dom='*' and mon='*' are supported".to_string());
    }

    let minutes = parse_minutes(minute_field)?;
    let hours = parse_hours(hour_field)?;
    let weekdays = parse_weekdays(dow_field)?;

    Ok(ParsedCron {
        minutes,
        hours,
        weekdays,
    })
}

fn parse_minutes(field: &str) -> Result<Vec<u32>, String> {
    let trimmed = field.trim();
    if trimmed.chars().all(|value| value.is_ascii_digit()) && !trimmed.is_empty() {
        let minute = parse_digits(trimmed, "minute")?;
        if minute > 59 {
            return Err("minute out of range".to_string());
        }
        return Ok(vec![minute]);
    }
    if let Some(step) = trimmed.strip_prefix("*/") {
        if step.is_empty() || !step.chars().all(|value| value.is_ascii_digit()) {
            return Err("minute must be N or */N".to_string());
        }
        let step = parse_digits(step, "minute step")?;
        if step == 0 || step > 60 {
            return Err("minute step out of range".to_string());
        }
        if 60 % step != 0 {
            return Err("minute step must divide 60".to_string());
        }
        return Ok((0..60).step_by(step as usize).collect());
    }
    Err("minute must be N or */N".to_string())
}

fn parse_hours(field: &str) -> Result<Vec<u32>, String> {
    let trimmed = field.trim();
    if trimmed == "*" {
        return Ok((0..24).collect());
    }
    if trimmed.chars().all(|value| value.is_ascii_digit()) && !trimmed.is_empty() {
        let hour = parse_digits(trimmed, "hour")?;
        if hour > 23 {
            return Err("hour out of range".to_string());
        }
        return Ok(vec![hour]);
    }
    Err("hour must be N or *".to_string())
}

fn parse_weekdays(field: &str) -> Result<Option<BTreeSet<u32>>, String> {
    let trimmed = field.trim();
    if trimmed == "*" {
        return Ok(None);
    }
    let mut weekdays = BTreeSet::new();
    for token in trimmed
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some((start, end)) = token.split_once('-') {
            let start = parse_weekday(start, "dow range start")?;
            let end = parse_weekday(end, "dow range end")?;
            if end < start {
                return Err("dow range must be increasing".to_string());
            }
            for value in start..=end {
                weekdays.insert(if value == 7 { 0 } else { value });
            }
            continue;
        }
        if !token.chars().all(|value| value.is_ascii_digit()) || token.is_empty() {
            return Err("dow must be N, N-N, or list".to_string());
        }
        let value = parse_digits(token, "dow")?;
        if value > 7 {
            return Err("dow out of range (0-7)".to_string());
        }
        weekdays.insert(if value == 7 { 0 } else { value });
    }
    if weekdays.is_empty() {
        return Err("dow set is empty".to_string());
    }
    Ok(Some(weekdays))
}

fn parse_weekday(value: &str, label: &str) -> Result<u32, String> {
    if value.is_empty() || !value.chars().all(|item| item.is_ascii_digit()) {
        return Err("dow must be N, N-N, or list".to_string());
    }
    let parsed = parse_digits(value, label)?;
    if parsed > 7 {
        return Err("dow out of range (0-7)".to_string());
    }
    Ok(parsed)
}

fn parse_digits(value: &str, label: &str) -> Result<u32, String> {
    value
        .parse::<u32>()
        .map_err(|_| format!("Invalid {label}: {value}"))
}

pub fn compute_next_cron_run_at(cron: &str, timezone: &str, after_ms: i64) -> Result<i64, String> {
    let parsed = parse_supported_cron(cron)?;
    let timezone = timezone.trim();
    validate_time_zone(timezone)?;
    let zone = timezone
        .parse::<Tz>()
        .map_err(|_| format!("Invalid time zone: {timezone}"))?;
    let after = zone
        .timestamp_millis_opt(after_ms)
        .single()
        .ok_or_else(|| "Invalid after timestamp".to_string())?;
    let mut cursor = after
        .with_second(0)
        .and_then(|value| value.with_nanosecond(0))
        .unwrap_or(after)
        + ChronoDuration::minutes(1);

    for _ in 0..370 {
        let weekday = cursor.weekday().num_days_from_sunday();
        if parsed
            .weekdays
            .as_ref()
            .is_some_and(|weekdays| !weekdays.contains(&weekday))
        {
            cursor = next_midnight(cursor)?;
            continue;
        }

        for hour in &parsed.hours {
            if *hour < cursor.hour() {
                continue;
            }
            let minute_start = if *hour == cursor.hour() {
                cursor.minute()
            } else {
                0
            };
            let Some(minute) = parsed
                .minutes
                .iter()
                .copied()
                .find(|value| *value >= minute_start)
            else {
                continue;
            };
            let naive = NaiveDateTime::new(
                NaiveDate::from_ymd_opt(cursor.year(), cursor.month(), cursor.day())
                    .ok_or_else(|| "Invalid calendar date".to_string())?,
                chrono::NaiveTime::from_hms_opt(*hour, minute, 0)
                    .ok_or_else(|| "Invalid wall clock time".to_string())?,
            );
            let candidate = match zone.from_local_datetime(&naive) {
                LocalResult::Single(value) => Some(value.timestamp_millis()),
                LocalResult::Ambiguous(first, second) => {
                    let first_ms = first.timestamp_millis();
                    let second_ms = second.timestamp_millis();
                    Some(if first_ms > after_ms {
                        first_ms
                    } else {
                        second_ms
                    })
                }
                LocalResult::None => None,
            };
            if let Some(candidate) = candidate
                && candidate > after_ms
            {
                return Ok(candidate);
            }
        }
        cursor = next_midnight(cursor)?;
    }

    Err("No next run found within search horizon".to_string())
}

fn next_midnight(cursor: chrono::DateTime<Tz>) -> Result<chrono::DateTime<Tz>, String> {
    let date = cursor.date_naive() + ChronoDuration::days(1);
    let naive = date
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| "Invalid calendar date".to_string())?;
    match cursor.timezone().from_local_datetime(&naive) {
        LocalResult::Single(value) => Ok(value),
        LocalResult::Ambiguous(first, second) => Ok(first.min(second)),
        LocalResult::None => Ok(cursor.timezone().from_utc_datetime(&naive)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_next_daily_run_in_utc() {
        let after = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .expect("timestamp")
            .timestamp_millis();
        let next = compute_next_cron_run_at("0 9 * * *", "UTC", after).expect("next run");
        assert_eq!(
            chrono::DateTime::from_timestamp_millis(next)
                .expect("timestamp")
                .to_rfc3339(),
            "2026-01-01T09:00:00+00:00"
        );
    }

    #[test]
    fn computes_next_midnight_after_previous_minute() {
        let after = chrono::DateTime::parse_from_rfc3339("2025-12-31T23:59:00Z")
            .expect("timestamp")
            .timestamp_millis();
        let next = compute_next_cron_run_at("0 0 * * *", "UTC", after).expect("next run");
        assert_eq!(
            chrono::DateTime::from_timestamp_millis(next)
                .expect("timestamp")
                .to_rfc3339(),
            "2026-01-01T00:00:00+00:00"
        );
    }

    #[test]
    fn computes_next_run_in_a_named_timezone() {
        let after = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .expect("timestamp")
            .timestamp_millis();
        let next = compute_next_cron_run_at("0 9 * * *", "Asia/Shanghai", after).expect("next run");
        assert_eq!(
            chrono_tz::Asia::Shanghai
                .timestamp_millis_opt(next)
                .single()
                .expect("timestamp")
                .to_rfc3339(),
            "2026-01-01T09:00:00+08:00"
        );
    }

    #[test]
    fn skips_a_wall_clock_time_that_does_not_exist() {
        let after = chrono::DateTime::parse_from_rfc3339("2026-03-08T00:00:00Z")
            .expect("timestamp")
            .timestamp_millis();
        let next =
            compute_next_cron_run_at("30 2 * * *", "America/New_York", after).expect("next run");
        assert_eq!(
            chrono_tz::America::New_York
                .timestamp_millis_opt(next)
                .single()
                .expect("timestamp")
                .to_rfc3339(),
            "2026-03-09T02:30:00-04:00"
        );
    }

    #[test]
    fn supports_minute_steps_and_weekday_ranges() {
        let parsed = parse_supported_cron("*/15 * * * 1-5").expect("cron");
        assert_eq!(parsed.minutes, vec![0, 15, 30, 45]);
        assert_eq!(parsed.weekdays, Some(BTreeSet::from([1, 2, 3, 4, 5])));
    }

    #[test]
    fn rejects_unsupported_cron_shapes() {
        assert_eq!(
            parse_supported_cron("0 9 1 * *").expect_err("dom"),
            "Only dom='*' and mon='*' are supported"
        );
        assert_eq!(
            parse_supported_cron("*/7 * * * *").expect_err("step"),
            "minute step must divide 60"
        );
        assert_eq!(
            parse_supported_cron("0 9 * * 5-1").expect_err("range"),
            "dow range must be increasing"
        );
    }
}
