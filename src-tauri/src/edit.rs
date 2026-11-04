//! Request bodies for creating and changing entries. Custom fields are never part of an
//! update, so values the form does not show (such as TOTP data) stay on the server.

use serde::Deserialize;
use serde_json::{json, Value};

/// `password` is only sent when set, so saving a form does not create a new password version.
#[derive(Deserialize, Debug, Default)]
pub struct EntryInput {
    pub name: String,
    pub username: String,
    pub url: String,
    pub notes: String,
    pub password: Option<String>,
}

fn editable_fields(input: &EntryInput) -> Result<Value, String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("Bitte einen Titel eingeben".into());
    }
    let mut body = json!({
        "Name": name,
        "Username": input.username.trim(),
        "Url": input.url.trim(),
        "Notes": input.notes,
    });
    if let Some(password) = input.password.as_deref().filter(|p| !p.is_empty()) {
        body["Password"] = json!(password);
    }
    Ok(body)
}

pub fn create_body(group_id: &str, input: &EntryInput) -> Result<Value, String> {
    let mut body = editable_fields(input)?;
    body["GroupId"] = json!(group_id);
    body["CustomUserFields"] = json!({});
    body["CustomApplicationFields"] = json!({});
    body["Tags"] = json!([]);
    Ok(body)
}

pub fn patch_body(input: &EntryInput) -> Result<Value, String> {
    editable_fields(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(password: Option<&str>) -> EntryInput {
        EntryInput {
            name: " VPN ".into(),
            username: "admin".into(),
            url: String::new(),
            notes: "a\nb".into(),
            password: password.map(str::to_string),
        }
    }

    #[test]
    fn create_contains_folder_and_trimmed_name() {
        let body = create_body("g", &input(Some("pw"))).unwrap();
        assert_eq!(body["GroupId"], "g");
        assert_eq!(body["Name"], "VPN");
        assert_eq!(body["Password"], "pw");
    }

    #[test]
    fn patch_without_new_password_omits_password() {
        assert!(patch_body(&input(None)).unwrap().get("Password").is_none());
        assert!(patch_body(&input(Some(""))).unwrap().get("Password").is_none());
    }

    #[test]
    fn patch_never_touches_custom_fields() {
        let body = patch_body(&input(Some("pw"))).unwrap();
        assert!(body.get("CustomUserFields").is_none());
        assert!(body.get("CustomApplicationFields").is_none());
    }

    #[test]
    fn patch_sends_empty_url_so_it_can_be_cleared() {
        assert_eq!(patch_body(&input(None)).unwrap()["Url"], "");
    }

    #[test]
    fn rejects_blank_name() {
        let blank = EntryInput { name: "  ".into(), ..EntryInput::default() };
        assert!(patch_body(&blank).is_err());
        assert!(create_body("g", &blank).is_err());
    }
}
