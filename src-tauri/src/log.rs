//! Small diagnostic log file. Callers pass only technical facts: never passwords, tokens,
//! one-time codes, user names or entry data. A failing log must never disturb the app,
//! so write errors are ignored on purpose.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_BYTES: u64 = 1024 * 1024;
const SECONDS_PER_DAY: u64 = 86_400;

static LOG: OnceLock<Mutex<PathBuf>> = OnceLock::new();

pub fn init(dir: &Path) {
    let _ = fs::create_dir_all(dir);
    let _ = LOG.set(Mutex::new(dir.join("pleasant-tray.log")));
}

pub fn write(message: &str) {
    let Some(lock) = LOG.get() else { return };
    let Ok(path) = lock.lock() else { return };
    let seconds = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    append(&path, &format_line(seconds, message), MAX_BYTES);
}

/// Keeps one older file, so the log cannot grow without limit.
fn append(path: &Path, line: &str, max_bytes: u64) {
    if fs::metadata(path).is_ok_and(|m| m.len() >= max_bytes) {
        let _ = fs::rename(path, path.with_extension("old.log"));
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

/// Line breaks are replaced, so a server message cannot fake further log lines.
fn format_line(unix_seconds: u64, message: &str) -> String {
    let clean = message.replace(['\r', '\n'], " ");
    format!("{} {clean}\n", utc_timestamp(unix_seconds))
}

fn utc_timestamp(unix_seconds: u64) -> String {
    let (year, month, day) = civil_date((unix_seconds / SECONDS_PER_DAY) as i64);
    let rest = unix_seconds % SECONDS_PER_DAY;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

/// Converts days since 1970 to a calendar date (Howard Hinnant's `civil_from_days`).
fn civil_date(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_utc_time() {
        assert_eq!(utc_timestamp(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc_timestamp(1_709_210_096), "2024-02-29T12:34:56Z");
    }

    #[test]
    fn line_breaks_cannot_fake_log_lines() {
        assert_eq!(format_line(0, "a\r\nb"), "1970-01-01T00:00:00Z a  b\n");
    }

    #[test]
    fn full_log_moves_to_the_old_file() {
        let dir = std::env::temp_dir().join(format!("pleasant-log-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.log");
        append(&path, "first\n", 3);
        append(&path, "second\n", 3);
        assert_eq!(fs::read_to_string(&path).unwrap(), "second\n");
        assert_eq!(fs::read_to_string(path.with_extension("old.log")).unwrap(), "first\n");
        fs::remove_dir_all(&dir).unwrap();
    }
}
