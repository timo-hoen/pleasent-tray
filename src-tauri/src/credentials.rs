//! Server and user name in Windows Credential Manager, to prefill the unlock form.
//! The password is never stored: it is the master password and only lives in RAM while
//! the app is unlocked.

use keyring::Entry;
use serde::{Deserialize, Serialize};

const SERVICE: &str = "pleasant-tray";
const ACCOUNT: &str = "login";

#[derive(Serialize, Deserialize)]
pub struct Stored {
    /// Logins saved before the server became selectable belong to the default server.
    #[serde(default = "default_server")]
    pub server: String,
    pub username: String,
}

fn default_server() -> String {
    crate::pleasant::DEFAULT_SERVER.to_string()
}

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("Anmeldedatenspeicher nicht verfügbar: {e}"))
}

pub fn load() -> Option<Stored> {
    let secret = entry().ok()?.get_password().ok()?;
    serde_json::from_str(&secret).ok()
}

pub fn save(stored: &Stored) -> Result<(), String> {
    let secret = serde_json::to_string(stored).map_err(|e| e.to_string())?;
    entry()?.set_password(&secret).map_err(|e| format!("Anmeldung nicht gespeichert: {e}"))
}

#[derive(Debug, PartialEq)]
enum Cleanup {
    Keep,
    Rewrite,
    Delete,
}

/// Anything that is not a clean login might contain a password, so it does not stay.
fn cleanup_for(secret: &str) -> Cleanup {
    let has_password = serde_json::from_str::<serde_json::Value>(secret)
        .map_or(true, |value| !value.is_object() || value.get("password").is_some());
    match (has_password, serde_json::from_str::<Stored>(secret).is_ok()) {
        (false, true) => Cleanup::Keep,
        (true, true) => Cleanup::Rewrite,
        (_, false) => Cleanup::Delete,
    }
}

/// Older versions also stored the password. Removes it, or reports why that failed.
pub fn remove_legacy_password() -> Result<(), String> {
    let secret = match entry()?.get_password() {
        Ok(secret) => secret,
        Err(keyring::Error::NoEntry) => return Ok(()),
        // Not text, so it cannot be judged: treated like any other unknown content.
        Err(keyring::Error::BadEncoding(_)) => return clear(),
        Err(e) => return Err(format!("Anmeldedatenspeicher nicht lesbar: {e}")),
    };
    match cleanup_for(&secret) {
        Cleanup::Keep => Ok(()),
        Cleanup::Delete => clear(),
        Cleanup::Rewrite => {
            let stored: Stored = serde_json::from_str(&secret).map_err(|e| e.to_string())?;
            save(&stored)
        }
    }
}

pub fn clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Anmeldung nicht gelöscht: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decides_cleanup_from_the_stored_content() {
        assert_eq!(cleanup_for(r#"{"server":"s","username":"u"}"#), Cleanup::Keep);
        assert_eq!(cleanup_for(r#"{"username":"u","password":"p"}"#), Cleanup::Rewrite);
        assert_eq!(cleanup_for(r#"{"password":"p"}"#), Cleanup::Delete);
        assert_eq!(cleanup_for("nur ein passwort"), Cleanup::Delete);
    }

    #[test]
    fn rewriting_a_legacy_login_drops_the_password() {
        let legacy = r#"{"server":"https://s","username":"u","password":"geheim"}"#;
        let stored: Stored = serde_json::from_str(legacy).unwrap();
        let rewritten = serde_json::to_string(&stored).unwrap();
        assert_eq!(stored.username, "u");
        assert!(!rewritten.contains("geheim"));
    }
}
