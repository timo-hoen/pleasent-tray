//! Looks for a newer GitHub release. The app only offers the setup for download: nothing is
//! installed by itself. A failed check must not disturb the start, so it is only logged.

use serde::{Deserialize, Serialize};

use crate::log;

const LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/timo-hoen/pleasent-tray/releases/latest";
/// Only setups from this repository are offered, whatever the response says.
const DOWNLOAD_PREFIX: &str = "https://github.com/timo-hoen/pleasent-tray/releases/download/";
const USER_AGENT: &str = concat!("pleasant-tray/", env!("CARGO_PKG_VERSION"));

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub setup_url: String,
}

fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let mut parts = text.strip_prefix('v').unwrap_or(text).split('.');
    let mut next = || parts.next()?.parse().ok();
    let version = (next()?, next()?, next()?);
    parts.next().is_none().then_some(version)
}

fn newer_setup(release: &Release, current: &str) -> Option<UpdateInfo> {
    if parse_version(&release.tag_name)? <= parse_version(current)? {
        return None;
    }
    let asset = release.assets.iter().find(|asset| {
        asset.name.to_lowercase().ends_with("-setup.exe")
            && asset.browser_download_url.starts_with(DOWNLOAD_PREFIX)
    })?;
    Some(UpdateInfo {
        version: release.tag_name.trim_start_matches('v').to_string(),
        setup_url: asset.browser_download_url.clone(),
    })
}

async fn latest_release(client: &reqwest::Client) -> Result<Release, reqwest::Error> {
    client
        .get(LATEST_RELEASE_URL)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
}

pub async fn check(client: &reqwest::Client) -> Option<UpdateInfo> {
    match latest_release(client).await {
        Ok(release) => newer_setup(&release, env!("CARGO_PKG_VERSION")),
        Err(error) => {
            log::write(&format!("Update-Prüfung fehlgeschlagen: {error}"));
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, url: &str) -> Release {
        Release {
            tag_name: tag.into(),
            assets: vec![
                Asset { name: "notes.txt".into(), browser_download_url: format!("{DOWNLOAD_PREFIX}x/notes.txt") },
                Asset { name: "Pleasant.Tray_x64-setup.exe".into(), browser_download_url: url.into() },
            ],
        }
    }

    fn setup_url() -> String {
        format!("{DOWNLOAD_PREFIX}v0.2.0/Pleasant.Tray_x64-setup.exe")
    }

    #[test]
    fn offers_the_setup_of_a_newer_release() {
        let found = newer_setup(&release("v0.2.0", &setup_url()), "0.1.0");
        assert_eq!(found, Some(UpdateInfo { version: "0.2.0".into(), setup_url: setup_url() }));
    }

    #[test]
    fn accepts_the_url_format_github_really_returns() {
        let url = "https://github.com/timo-hoen/pleasent-tray/releases/download/v9.0.0/Pleasant.Tray_9.0.0_x64-setup.exe";
        assert!(newer_setup(&release("v9.0.0", url), "0.1.0").is_some());
    }

    #[test]
    fn compares_versions_as_numbers() {
        assert!(newer_setup(&release("v0.10.0", &setup_url()), "0.9.0").is_some());
    }

    #[test]
    fn ignores_same_and_older_versions() {
        assert_eq!(newer_setup(&release("v0.1.0", &setup_url()), "0.1.0"), None);
        assert_eq!(newer_setup(&release("v0.0.9", &setup_url()), "0.1.0"), None);
    }

    #[test]
    fn rejects_malformed_tags_and_foreign_download_urls() {
        assert_eq!(newer_setup(&release("latest", &setup_url()), "0.1.0"), None);
        assert_eq!(newer_setup(&release("v1.0.0-beta", &setup_url()), "0.1.0"), None);
        assert_eq!(newer_setup(&release("v0.2.0", "https://evil.example/setup.exe"), "0.1.0"), None);
    }
}
