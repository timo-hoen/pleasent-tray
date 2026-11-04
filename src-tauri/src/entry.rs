//! Parses an entry's JSON and computes TOTP codes locally (RFC 6238).
//! Parsing is tolerant: API versions differ (custom fields as map or as a list
//! of Key/Value, TOTP as top-level fields or as a nested object).

use data_encoding::BASE32_NOPAD;
use serde::Serialize;
use serde_json::Value;
use totp_lite::{totp_custom, Sha1, Sha256, Sha512};

const DEFAULT_DIGITS: u32 = 6;
const DEFAULT_PERIOD: u64 = 30;
const SECRET_HINTS: [&str; 6] = ["pass", "pwd", "kennwort", "pin", "secret", "key"];

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Field {
    pub key: String,
    pub value: String,
    pub secret: bool,
}

#[derive(Serialize, Debug)]
pub struct Detail {
    pub id: String,
    pub name: String,
    pub username: String,
    pub url: String,
    pub notes: String,
    pub fields: Vec<Field>,
    pub has_totp: bool,
    pub comment_required: bool,
    pub can_edit_totp: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Algorithm {
    Sha1,
    Sha256,
    Sha512,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Totp {
    pub secret: Vec<u8>,
    pub digits: u32,
    pub period: u64,
    pub algorithm: Algorithm,
}

impl Totp {
    /// Returns the code and the seconds it stays valid.
    pub fn code(&self, unix_seconds: u64) -> (String, u64) {
        let code = match self.algorithm {
            Algorithm::Sha1 => totp_custom::<Sha1>(self.period, self.digits, &self.secret, unix_seconds),
            Algorithm::Sha256 => totp_custom::<Sha256>(self.period, self.digits, &self.secret, unix_seconds),
            Algorithm::Sha512 => totp_custom::<Sha512>(self.period, self.digits, &self.secret, unix_seconds),
        };
        (code, self.period - unix_seconds % self.period)
    }
}

/// Reads what a user pastes when setting up TOTP: a Base32 secret or an `otpauth://` URI.
/// The server only stores secret, digits and period, so it always computes with SHA-1.
pub fn totp_from_input(input: &str) -> Result<Totp, String> {
    let text = input.trim();
    let totp = if text.to_lowercase().starts_with("otpauth://") {
        from_uri(text).ok_or("Der TOTP-Link ist ungültig")?
    } else {
        build(text, None, None, Algorithm::Sha1).ok_or("Der TOTP-Schlüssel ist ungültig")?
    };
    if totp.algorithm != Algorithm::Sha1 {
        return Err("Pleasant unterstützt für TOTP nur SHA-1".into());
    }
    Ok(totp)
}

pub fn encoded_secret(totp: &Totp) -> String {
    BASE32_NOPAD.encode(&totp.secret)
}

pub fn parse(value: &Value) -> (Detail, Option<Totp>) {
    let pairs = custom_fields(value);
    let totp = find_totp(value, &pairs);
    let fields = pairs
        .into_iter()
        .filter(|(key, val)| !val.is_empty() && !is_totp_field(key, val))
        .map(|(key, value)| {
            let lower = key.to_lowercase();
            let secret = SECRET_HINTS.iter().any(|h| lower.contains(h));
            Field { key, value, secret }
        })
        .collect();
    let detail = Detail {
        id: text(value, "Id"),
        name: text(value, "Name"),
        username: text(value, "Username"),
        url: text(value, "Url"),
        notes: text(value, "Notes"),
        fields,
        has_totp: totp.is_some(),
        can_edit_totp: value.get("HasModifyTOTPAccess").and_then(Value::as_bool).unwrap_or(false),
        comment_required: value
            .pointer("/CommentPrompts/AskForCommentOnViewPassword")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    };
    (detail, totp)
}

/// Finds TOTP data for an entry whose normal JSON may not include it.
pub fn totp_from(value: &Value) -> Option<Totp> {
    find_totp(value, &custom_fields(value))
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn custom_fields(value: &Value) -> Vec<(String, String)> {
    let user = pairs_of(value.get("CustomUserFields"));
    let app = pairs_of(value.get("CustomApplicationFields"));
    // Application fields are KeePass internals: only TOTP data is relevant there.
    user.into_iter().chain(app.into_iter().filter(|(k, v)| is_totp_field(k, v))).collect()
}

fn pairs_of(fields: Option<&Value>) -> Vec<(String, String)> {
    match fields {
        Some(Value::Object(map)) => map
            .iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
            .collect(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| Some((item.get("Key")?.as_str()?.to_string(), item.get("Value")?.as_str()?.to_string())))
            .collect(),
        _ => Vec::new(),
    }
}

fn is_totp_field(key: &str, value: &str) -> bool {
    let lower = key.to_lowercase();
    value.starts_with("otpauth://") || lower.contains("otp")
}

fn find_totp(value: &Value, pairs: &[(String, String)]) -> Option<Totp> {
    if let Some(found) = pairs.iter().find_map(|(_, v)| v.starts_with("otpauth://").then(|| from_uri(v)).flatten()) {
        return Some(found);
    }
    let nested = ["Totp", "TOTP"].iter().find_map(|k| value.get(*k)).filter(|v| v.is_object());
    if let Some(found) = nested.and_then(|t| {
        let secret = t.get("Secret")?.as_str()?;
        build(secret, number(t, "Digits"), number(t, "Period"), Algorithm::Sha1)
    }) {
        return Some(found);
    }
    if let Some(found) = value.get("TOTPSecret").and_then(Value::as_str).and_then(|s| {
        build(s, number(value, "TOTPDigits"), number(value, "TOTPPeriod"), Algorithm::Sha1)
    }) {
        return Some(found);
    }
    let setting = |needle: &str| {
        pairs
            .iter()
            .find(|(k, _)| k.to_lowercase().contains("otp") && k.to_lowercase().contains(needle))
            .and_then(|(_, v)| v.parse::<u64>().ok())
    };
    pairs
        .iter()
        .filter(|(k, _)| {
            let lower = k.to_lowercase();
            lower.contains("otp") && !["length", "digits", "period", "algorithm", "settings"].iter().any(|s| lower.contains(s))
        })
        .find_map(|(_, v)| build(v, setting("length").or(setting("digits")), setting("period"), Algorithm::Sha1))
}

fn number(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64).filter(|n| *n > 0)
}

fn from_uri(uri: &str) -> Option<Totp> {
    let query = uri.split_once('?')?.1;
    let param = |name: &str| {
        query.split('&').filter_map(|p| p.split_once('=')).find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v)
    };
    let algorithm = match param("algorithm").unwrap_or("SHA1").to_uppercase().as_str() {
        "SHA1" => Algorithm::Sha1,
        "SHA256" => Algorithm::Sha256,
        "SHA512" => Algorithm::Sha512,
        _ => return None,
    };
    build(
        param("secret")?,
        param("digits").and_then(|d| d.parse().ok()),
        param("period").and_then(|p| p.parse().ok()),
        algorithm,
    )
}

fn build(secret: &str, digits: Option<u64>, period: Option<u64>, algorithm: Algorithm) -> Option<Totp> {
    let cleaned: String = secret
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '=')
        .collect::<String>()
        .to_uppercase();
    if cleaned.is_empty() {
        return None;
    }
    let digits = digits.map_or(DEFAULT_DIGITS, |d| d as u32);
    let period = period.unwrap_or(DEFAULT_PERIOD);
    if !(4..=10).contains(&digits) || period == 0 {
        return None;
    }
    Some(Totp { secret: BASE32_NOPAD.decode(cleaned.as_bytes()).ok()?, digits, period, algorithm })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // RFC 6238 test secret "12345678901234567890" in Base32.
    const RFC_SECRET: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    #[test]
    fn computes_rfc6238_vector_and_remaining_seconds() {
        let totp = build(RFC_SECRET, Some(8), None, Algorithm::Sha1).unwrap();
        assert_eq!(totp.code(59), ("94287082".to_string(), 1));
    }

    #[test]
    fn reads_otpauth_uri_from_custom_field_and_hides_it() {
        let uri = format!("otpauth://totp/x?secret={RFC_SECRET}&digits=8&period=60");
        let (detail, totp) = parse(&json!({"CustomUserFields": {"otp": uri, "TeamViewer ID": "123"}}));
        let totp = totp.unwrap();
        assert_eq!((totp.digits, totp.period), (8, 60));
        assert!(detail.has_totp);
        assert_eq!(detail.fields.len(), 1);
        assert_eq!(detail.fields[0].key, "TeamViewer ID");
    }

    #[test]
    fn reads_keepass_timeotp_fields() {
        let (_, totp) = parse(&json!({"CustomUserFields": {
            "TimeOtp-Secret-Base32": RFC_SECRET, "TimeOtp-Length": "8", "TimeOtp-Period": "45"}}));
        let totp = totp.unwrap();
        assert_eq!((totp.digits, totp.period), (8, 45));
    }

    #[test]
    fn reads_v7_top_level_and_nested_totp() {
        let top = totp_from(&json!({"TOTPSecret": RFC_SECRET, "TOTPDigits": 7, "TOTPPeriod": 20})).unwrap();
        assert_eq!((top.digits, top.period), (7, 20));
        let nested = totp_from(&json!({"Totp": {"Secret": RFC_SECRET, "Digits": 6, "Period": 30}})).unwrap();
        assert_eq!(nested.digits, 6);
    }

    #[test]
    fn reads_custom_fields_as_key_value_list_and_marks_secrets() {
        let (detail, totp) = parse(&json!({"CustomUserFields": [
            {"Key": "TeamViewer Passwort", "Value": "x"}, {"Key": "TeamViewer ID", "Value": "1"}]}));
        assert!(totp.is_none());
        assert!(detail.fields[0].secret);
        assert!(!detail.fields[1].secret);
    }

    #[test]
    fn setup_accepts_secret_with_spaces_and_uri() {
        let plain = totp_from_input(" gezd gnbv gy3t qojq gezd gnbv gy3t qojq ").unwrap();
        assert_eq!(encoded_secret(&plain), RFC_SECRET);
        assert_eq!((plain.digits, plain.period), (6, 30));
        let uri = format!("otpauth://totp/x?secret={RFC_SECRET}&digits=8&period=60");
        let linked = totp_from_input(&uri).unwrap();
        assert_eq!((linked.digits, linked.period), (8, 60));
    }

    #[test]
    fn setup_rejects_invalid_input_and_other_algorithms() {
        assert!(totp_from_input("not base32!").is_err());
        assert!(totp_from_input("otpauth://totp/x").is_err());
        let uri = format!("otpauth://totp/x?secret={RFC_SECRET}&algorithm=SHA256");
        assert!(totp_from_input(&uri).is_err());
    }

    #[test]
    fn reads_totp_edit_permission() {
        let (detail, _) = parse(&json!({"HasModifyTOTPAccess": true}));
        assert!(detail.can_edit_totp);
        assert!(!parse(&json!({})).0.can_edit_totp);
    }

    #[test]
    fn invalid_secret_gives_no_totp() {
        assert!(totp_from(&json!({"TOTPSecret": "not base32!"})).is_none());
    }

    #[test]
    fn reads_comment_requirement() {
        let (detail, _) = parse(&json!({"CommentPrompts": {"AskForCommentOnViewPassword": true}}));
        assert!(detail.comment_required);
    }
}
