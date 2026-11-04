//! Encrypted folder cache on disk. The key comes from the master password (Argon2id) and is
//! not stored, so the file is unreadable while the app is locked. The account is
//! authenticated with the data, so a cache never opens for another server or user.
//!
//! File layout: version byte, salt, nonce, AES-256-GCM ciphertext.

use aes_gcm::{
    aead::{Aead, KeyInit, OsRng, Payload},
    AeadCore, Aes256Gcm, Key, Nonce,
};
use argon2::Argon2;
use rand_core::RngCore;

const VERSION: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const HEADER_LEN: usize = 1 + SALT_LEN + NONCE_LEN;

fn cipher(password: &str, salt: &[u8]) -> Result<Aes256Gcm, String> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| format!("Schlüssel nicht ableitbar: {e}"))?;
    Ok(Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key)))
}

pub fn seal(plain: &[u8], password: &str, account: &str) -> Result<Vec<u8>, String> {
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher(password, &salt)?
        .encrypt(&nonce, Payload { msg: plain, aad: account.as_bytes() })
        .map_err(|_| "Verschlüsselung fehlgeschlagen".to_string())?;
    Ok([&[VERSION], salt.as_slice(), nonce.as_slice(), ciphertext.as_slice()].concat())
}

/// `None` for anything that cannot be opened: the caller then loads from the server.
pub fn open(data: &[u8], password: &str, account: &str) -> Option<Vec<u8>> {
    if data.len() <= HEADER_LEN || data[0] != VERSION {
        return None;
    }
    let (salt, rest) = data[1..].split_at(SALT_LEN);
    let (nonce, ciphertext) = rest.split_at(NONCE_LEN);
    cipher(password, salt)
        .ok()?
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ciphertext, aad: account.as_bytes() })
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_only_with_same_password_and_account() {
        let sealed = seal(b"baum", "pw", "s\nu").unwrap();
        assert_eq!(open(&sealed, "pw", "s\nu").unwrap(), b"baum");
        assert!(open(&sealed, "falsch", "s\nu").is_none());
        assert!(open(&sealed, "pw", "s\nanderer").is_none());
    }

    #[test]
    fn rejects_changed_or_short_data_and_hides_the_content() {
        let sealed = seal(b"geheimer-ordner", "pw", "a").unwrap();
        assert!(!sealed.windows(7).any(|w| w == b"geheime"));
        let mut changed = sealed.clone();
        *changed.last_mut().unwrap() ^= 1;
        assert!(open(&changed, "pw", "a").is_none());
        assert!(open(&sealed[..HEADER_LEN], "pw", "a").is_none());
        assert!(open(&[], "pw", "a").is_none());
    }
}
