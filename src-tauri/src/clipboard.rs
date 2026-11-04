//! Clipboard writes. Sensitive values stay out of the Windows clipboard history
//! and are removed after a timeout, unless the user has copied something else.

use arboard::{Clipboard, SetExtWindows};
use std::{sync::Mutex, thread, time::Duration};

const CLEAR_AFTER: Duration = Duration::from_secs(30);
static LAST_SENSITIVE: Mutex<Option<String>> = Mutex::new(None);

pub fn copy(text: &str, sensitive: bool) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|e| format!("Zwischenablage nicht verfügbar: {e}"))?;
    let result = if sensitive {
        clipboard.set().exclude_from_history().text(text)
    } else {
        clipboard.set_text(text)
    };
    result.map_err(|e| format!("Kopieren fehlgeschlagen: {e}"))?;
    if sensitive {
        let copied = text.to_string();
        if let Ok(mut last) = LAST_SENSITIVE.lock() {
            *last = Some(copied.clone());
        }
        thread::spawn(move || {
            thread::sleep(CLEAR_AFTER);
            clear_if_current(&copied);
        });
    }
    Ok(())
}

fn clear_if_current(copied: &str) {
    if let Ok(mut clipboard) = Clipboard::new() {
        if clipboard.get_text().is_ok_and(|current| current == copied) {
            let _ = clipboard.clear();
        }
    }
}

/// Called when the app locks, so a copied secret does not wait for the timeout.
pub fn clear_sensitive() {
    let last = LAST_SENSITIVE.lock().ok().and_then(|mut last| last.take());
    if let Some(copied) = last {
        clear_if_current(&copied);
    }
}
