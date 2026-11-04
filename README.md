# Pleasant Tray

Schlanker Windows-Client für [Pleasant Password Server](https://pleasantpasswords.com/), der im Infobereich der Taskleiste läuft. Gebaut mit [Tauri 2](https://tauri.app/) und Rust.

## Funktionen

- Alle Ordner durchsuchen (`Strg+K` springt ins Suchfeld) und einzelne Ordner filtern
- Einträge ansehen, anlegen und bearbeiten
- Benutzername, Passwort und weitere Felder in die Zwischenablage kopieren
- TOTP-Codes anzeigen
- Anmeldung mit Zwei-Faktor-Code
- Automatisches Sperren der App

## Installation

Das Setup liegt unter [Releases](https://github.com/timo-hoen-ias/pleasent-tray/releases). Die Installation braucht keine Administratorrechte. Fehlt die Microsoft WebView2 Runtime, lädt der Installer sie nach.

Beim ersten Start gibst du die Adresse deines Servers ein. Es sind nur `https`-Adressen erlaubt.

## Selbst bauen

Voraussetzungen: Windows, [Rust](https://rustup.rs/) (stable) und die Tauri-CLI.

```powershell
cargo install tauri-cli --version "^2" --locked
cd src-tauri
cargo tauri build
```

Das Setup liegt danach unter `src-tauri/target/release/bundle/nsis/`.

Tests laufen mit `cargo test` in `src-tauri`.

### Optionale Build-Variablen

Für den internen Einsatz lassen sich beim Bauen Vorgaben setzen. Sie werden in die Binärdatei einkompiliert, deshalb sollten so gebaute Dateien nicht öffentlich verteilt werden.

| Variable | Bedeutung | Beispiel |
| --- | --- | --- |
| `PLEASANT_DEFAULT_SERVER` | Vorbelegte Serveradresse | `https://vault.example:8443` |
| `PLEASANT_SERVER_ADDR` | Löst den Namen des vorbelegten Servers fest auf diese Adresse auf, falls er nicht per DNS erreichbar ist. Die TLS-Prüfung bleibt aktiv. Braucht `PLEASANT_DEFAULT_SERVER`. | `192.0.2.1:8443` |

## CI und Releases

GitHub Actions baut das Setup bei jedem Push auf `main` und bei Pull Requests und stellt es als Artefakt bereit.

Für ein Release die Version in `src-tauri/tauri.conf.json` anheben und einen passenden Tag pushen, zum Beispiel `v0.2.0`. Der Workflow erstellt dann ein GitHub-Release mit dem Setup.
