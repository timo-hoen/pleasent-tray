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

/// Marks a server whose certificate is not checked. Only an explicit `?unsafe=1` in the
/// address sets it, and it stays part of the stored address.
const UNSAFE_SUFFIX: &str = "?unsafe=1";

pub struct Clients {
    verified: Client,
    unverified: Client,
}

impl Clients {
    /// For requests outside the Pleasant server, which always check the certificate.
    pub fn verified(&self) -> &Client {
        &self.verified
    }

    /// Picks the client for a stored address and returns the address to send requests to.
    fn for_server<'a>(&self, server: &'a str) -> (&Client, &'a str) {
        match server.strip_suffix(UNSAFE_SUFFIX) {
            Some(base) => (&self.unverified, base),
            None => (&self.verified, server),
        }
    }
}

pub fn build_client() -> Result<Clients, String> {
    let verified = client_builder()?
        .build()
        .map_err(|e| format!("HTTP-Client konnte nicht starten: {e}"))?;
    let unverified = client_builder()?
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| format!("HTTP-Client konnte nicht starten: {e}"))?;
    Ok(Clients { verified, unverified })
}

fn client_builder() -> Result<reqwest::ClientBuilder, String> {
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
    Ok(builder.connect_timeout(CONNECT_TIMEOUT).timeout(REQUEST_TIMEOUT))
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
    let origin = map_pinned(url.origin().ascii_serialization(), PINNED_ADDR, DEFAULT_SERVER);
    let is_unsafe = url.query_pairs().any(|(key, value)| key == "unsafe" && value == "1");
    Ok(if is_unsafe { format!("{origin}{UNSAFE_SUFFIX}") } else { origin })
}

fn map_pinned(origin: String, pinned: Option<&str>, default_server: &str) -> String {
    match pinned {
        Some(addr) if origin == format!("https://{addr}") => default_server.to_string(),
        _ => origin,
    }
}

/// Text for the UI. Shows the pinned IP for the default server, since DNS is not used there.
pub fn server_label(server: &str) -> String {
    match server.strip_suffix(UNSAFE_SUFFIX) {
        Some(base) => format!("{} – UNSICHER, Zertifikat ungeprüft", label_for(base, PINNED_ADDR, DEFAULT_SERVER)),
        None => label_for(server, PINNED_ADDR, DEFAULT_SERVER),
    }
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
    clients: &Clients,
    server: &str,
    username: &str,
    password: &str,
    otp: Option<(&str, &str)>,
) -> Result<TokenResult, String> {
    let (client, server_base) = clients.for_server(server);
    if server_base != server {
        crate::log::write("WARNUNG: Anmeldung ohne Zertifikatsprüfung (unsafe=1)");
    }
    let server = server_base;
    let mut request = client.post(format!("{server}/OAuth2/Token")).form(&[
        ("grant_type", "password"),
        ("username", username),
        ("password", password),
    ]);
    if let Some((code, provider)) = otp {
        request = request.header("X-Pleasant-OTP", code).header("X-Pleasant-OTP-Provider", provider);
    }
    let response = request.send().await.map_err(connection_error)?;
    log_status("Anmeldung", "POST", response.status());
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
    clients: &Clients,
    server: &str,
    token: &str,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, FetchError> {
    let (client, server) = clients.for_server(server);
    let method_name = method.to_string();
    let mut builder = client.request(method, format!("{server}{path}")).bearer_auth(token);
    if let Some(body) = body {
        builder = builder.json(body);
    }
    let response = builder.send().await.map_err(|e| FetchError::Other(connection_error(e)))?;
    log_status("Anfrage", &method_name, response.status());
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

/// The top-level text only says "error sending request", the real reason (DNS, TLS, refused
/// connection, timeout) sits in the error's sources.
fn connection_error(error: reqwest::Error) -> String {
    let host = error.url().map_or_else(|| "?".to_string(), host_and_port);
    let error = error.without_url();
    let mut reasons = vec![error.to_string()];
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source {
        reasons.push(cause.to_string());
        source = cause.source();
    }
    let message = format!("Server nicht erreichbar: {}", reasons.join(": "));
    crate::log::write(&format!("Verbindung zu {host} fehlgeschlagen: {}", reasons.join(": ")));
    message
}

fn host_and_port(url: &Url) -> String {
    format!(
        "{}:{}",
        url.host_str().unwrap_or("?"),
        url.port_or_known_default().map_or_else(|| "?".to_string(), |p| p.to_string())
    )
}

fn log_status(action: &str, method: &str, status: StatusCode) {
    if !status.is_success() {
        crate::log::write(&format!("{action} {method}: HTTP {}", status.as_u16()));
    }
}

/// Logged at startup. Says whether a fixed address was compiled in, but not which one.
pub fn startup_summary() -> String {
    format!(
        "Start: Version {}, Standardserver {}, feste Adresse {}",
        env!("CARGO_PKG_VERSION"),
        if DEFAULT_SERVER.is_empty() { "nein" } else { "ja" },
        if PINNED_ADDR.is_some() { "ja" } else { "nein" },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_error_names_the_real_cause_without_credentials() {
        let client = build_client().unwrap();
        let result = tauri::async_runtime::block_on(request_token(
            &client,
            "https://127.0.0.1:1",
            "geheimer-name",
            "geheimes-passwort",
            None,
        ));
        let Err(message) = result else { panic!("port 1 should refuse") };
        println!("{message}");
        assert!(message.len() > "Server nicht erreichbar: error sending request".len());
        assert!(!message.contains("geheim"));
    }

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
    fn only_an_explicit_unsafe_flag_turns_off_the_check() {
        let clients = build_client().unwrap();
        let unsafe_server = normalize_server("192.0.2.1:8443/x?unsafe=1").unwrap();
        assert_eq!(unsafe_server, "https://192.0.2.1:8443?unsafe=1");
        assert_eq!(clients.for_server(&unsafe_server).1, "https://192.0.2.1:8443");
        assert!(server_label(&unsafe_server).contains("UNSICHER"));
        for input in ["vault.example", "vault.example?unsafe=0", "vault.example?other=1"] {
            let server = normalize_server(input).unwrap();
            assert_eq!(server, "https://vault.example");
            assert!(!server_label(&server).contains("UNSICHER"));
        }
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
