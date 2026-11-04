//! Pleasant Password Server API client.
//!
//! Optional build-time settings, so no deployment details live in the source:
//! `PLEASANT_DEFAULT_SERVER` prefills the server address. `PLEASANT_SERVER_ADDR` (`ip:port`)
//! additionally resolves that server's name to a fixed address, for certificates that are
//! issued for the name but not the IP. TLS stays fully verified.

use reqwest::{Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{net::SocketAddr, time::Duration};

const PINNED_ADDR: Option<&str> = option_env!("PLEASANT_SERVER_ADDR");
pub const DEFAULT_SERVER: &str = match option_env!("PLEASANT_DEFAULT_SERVER") {
    Some(server) => server,
    None => "",
};
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LoginOutcome {
    Ok,
    OtpRequired { provider: String },
}

pub enum TokenResult {
    Token(String),
    OtpRequired(String),
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
}

#[derive(Deserialize, Default)]
struct ErrorResponse {
    error_description: Option<String>,
}

pub enum FetchError {
    Unauthorized,
    Other(String),
}

pub fn build_client() -> Result<Client, String> {
    let builder = match PINNED_ADDR {
        Some(pinned) => {
            let addr: SocketAddr =
                pinned.parse().map_err(|_| "Ungültige Serveradresse".to_string())?;
            let url = Url::parse(DEFAULT_SERVER).map_err(|_| "Ungültige Serveradresse".to_string())?;
            let host = url.host_str().ok_or("Ungültige Serveradresse")?;
            Client::builder().resolve(host, addr)
        }
        None => Client::builder(),
    };
    builder
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("HTTP-Client konnte nicht starten: {e}"))
}

/// Reduces any typed address to `https://host[:port]`. Plain http is rejected, because
/// the login would travel unencrypted. A pinned IP maps to the name on its certificate.
pub fn normalize_server(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Bitte Serveradresse eingeben".into());
    }
    let with_scheme =
        if trimmed.contains("://") { trimmed.to_string() } else { format!("https://{trimmed}") };
    let url = Url::parse(&with_scheme).map_err(|_| "Ungültige Serveradresse".to_string())?;
    if url.scheme() != "https" {
        return Err("Nur https-Adressen sind erlaubt".into());
    }
    Ok(map_pinned(url.origin().ascii_serialization(), PINNED_ADDR, DEFAULT_SERVER))
}

fn map_pinned(origin: String, pinned: Option<&str>, default_server: &str) -> String {
    match pinned {
        Some(addr) if origin == format!("https://{addr}") => default_server.to_string(),
        _ => origin,
    }
}

/// Text for the UI. Shows the pinned IP for the default server, since DNS is not used there.
pub fn server_label(server: &str) -> String {
    label_for(server, PINNED_ADDR, DEFAULT_SERVER)
}

fn label_for(server: &str, pinned: Option<&str>, default_server: &str) -> String {
    let host = server.trim_start_matches("https://");
    match pinned {
        Some(addr) if server == default_server => {
            let ip = addr.split(':').next().unwrap_or(addr);
            format!("{host} ({ip})")
        }
        _ => host.to_string(),
    }
}

pub async fn request_token(
    client: &Client,
    server: &str,
    username: &str,
    password: &str,
    otp: Option<(&str, &str)>,
) -> Result<TokenResult, String> {
    let mut request = client.post(format!("{server}/OAuth2/Token")).form(&[
        ("grant_type", "password"),
        ("username", username),
        ("password", password),
    ]);
    if let Some((code, provider)) = otp {
        request = request.header("X-Pleasant-OTP", code).header("X-Pleasant-OTP-Provider", provider);
    }
    let response = request.send().await.map_err(connection_error)?;
    if response.status().is_success() {
        let token: TokenResponse =
            response.json().await.map_err(|_| "Unerwartete Antwort vom Server".to_string())?;
        return Ok(TokenResult::Token(token.access_token));
    }
    let otp_required = response.headers().get("X-Pleasant-OTP").is_some_and(|v| v == "required");
    let provider = response
        .headers()
        .get("X-Pleasant-OTP-Provider")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    if otp_required {
        return Ok(TokenResult::OtpRequired(provider));
    }
    let error: ErrorResponse = response.json().await.unwrap_or_default();
    Err(error.error_description.unwrap_or_else(|| "Anmeldung fehlgeschlagen".to_string()))
}

pub async fn request(
    client: &Client,
    server: &str,
    token: &str,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, FetchError> {
    let mut builder = client.request(method, format!("{server}{path}")).bearer_auth(token);
    if let Some(body) = body {
        builder = builder.json(body);
    }
    let response = builder.send().await.map_err(|e| FetchError::Other(connection_error(e)))?;
    match response.status() {
        StatusCode::UNAUTHORIZED => Err(FetchError::Unauthorized),
        StatusCode::FORBIDDEN => {
            Err(FetchError::Other("Keine Berechtigung für diese Aktion".to_string()))
        }
        s if s.is_success() => {
            let text = response
                .text()
                .await
                .map_err(|e| FetchError::Other(format!("Antwort nicht lesbar: {e}")))?;
            parse_body(&text).map_err(FetchError::Other)
        }
        s => Err(FetchError::Other(format!("Server antwortet mit {}", s.as_u16()))),
    }
}

/// Updates answer 204 without a body, which counts as a success without a value.
fn parse_body(text: &str) -> Result<Value, String> {
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(text).map_err(|e| format!("Antwort nicht lesbar: {e}"))
}

fn connection_error(error: reqwest::Error) -> String {
    format!("Server nicht erreichbar: {}", error.without_url())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_body_is_null_and_guid_string_is_parsed() {
        assert_eq!(parse_body("").unwrap(), Value::Null);
        assert_eq!(parse_body("\"abc\"").unwrap(), Value::String("abc".into()));
        assert!(parse_body("<html>").is_err());
    }

    #[test]
    fn pinned_ip_maps_to_certificate_name() {
        let origin = "https://192.0.2.1:8443".to_string();
        let default = "https://vault.example:8443";
        assert_eq!(map_pinned(origin.clone(), Some("192.0.2.1:8443"), default), default);
        assert_eq!(map_pinned(origin.clone(), None, default), origin);
    }

    #[test]
    fn strips_path_and_credentials_from_other_servers() {
        assert_eq!(
            normalize_server(" https://user:pw@vault.example:8443/x/ ").unwrap(),
            "https://vault.example:8443"
        );
    }

    #[test]
    fn rejects_http_and_empty_input() {
        assert!(normalize_server("http://vault.example").is_err());
        assert!(normalize_server("   ").is_err());
    }

    #[test]
    fn label_shows_ip_only_for_pinned_default_server() {
        let default = "https://vault.example:8443";
        assert_eq!(
            label_for(default, Some("192.0.2.1:8443"), default),
            "vault.example:8443 (192.0.2.1)"
        );
        assert_eq!(label_for("https://other.example", Some("192.0.2.1:8443"), default), "other.example");
        assert_eq!(label_for(default, None, default), "vault.example:8443");
    }
}
