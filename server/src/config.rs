use anyhow::Context;
use rand::distr::{Alphanumeric, SampleString};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DEFAULT_PORT: u16 = 17890;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub token: String,
    pub port: u16,
    /// Address to bind the WebSocket listener to. Defaults to the discovered
    /// LAN IP at runtime when None, so the server is reachable but not
    /// exposed on every interface (H-4).
    #[serde(default)]
    pub bind_addr: Option<String>,
    /// Whether to advertise the service over mDNS. Defaults to true to
    /// preserve the documented discovery flow; disable with `--no-mdns` or
    /// by setting this to false in the config (H-5).
    #[serde(default = "default_advertise_mdns")]
    pub advertise_mdns: bool,
    /// WebSocket `Origin` allowlist for defense against cross-site WebSocket
    /// hijacking (L-7). Empty means: allow clients that send no `Origin`
    /// (the native app, curl) and reject any browser origin. Non-empty
    /// allows only the listed origins plus origin-less clients.
    #[serde(default)]
    pub allowed_origins: Vec<String>,
}

fn default_advertise_mdns() -> bool {
    true
}

pub fn default_path() -> PathBuf {
    dirs::config_dir()
        .expect("no config directory on this platform")
        .join("remcontrol")
        .join("config.toml")
}

impl Config {
    pub fn load_or_create(path: &Path) -> anyhow::Result<Config> {
        if path.exists() {
            let raw = std::fs::read_to_string(path)?;
            return toml::from_str(&raw).context("invalid config file");
        }
        let cfg = Config {
            token: new_token(),
            port: DEFAULT_PORT,
            bind_addr: None,
            advertise_mdns: true,
            allowed_origins: Vec::new(),
        };
        cfg.save(path)?;
        Ok(cfg)
    }

    pub fn reset_token(path: &Path) -> anyhow::Result<Config> {
        let mut cfg = Config::load_or_create(path)?;
        cfg.token = new_token();
        cfg.save(path)?;
        Ok(cfg)
    }

    fn save(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        write_secret(path, toml::to_string_pretty(self)?)
    }
}

/// Write a file containing secret material with restrictive permissions
/// (M-6). On Unix we open with mode 0600; on non-Unix we fall back to a
/// plain write and rely on the containing directory's permissions.
fn write_secret(path: &Path, contents: String) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true).mode(0o600);
        std::io::Write::write_all(&mut opts.open(path)?, contents.as_bytes())?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, contents)?;
        Ok(())
    }
}

fn new_token() -> String {
    Alphanumeric.sample_string(&mut rand::rng(), 32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_config_with_token_on_first_load() {
        let dir = std::env::temp_dir().join(format!("remcontrol-test-{}", std::process::id()));
        let path = dir.join("config.toml");
        let _ = std::fs::remove_dir_all(&dir);
        let cfg = Config::load_or_create(&path).unwrap();
        assert_eq!(cfg.port, 17890);
        assert_eq!(cfg.token.len(), 32);
        assert!(cfg.advertise_mdns);
        let again = Config::load_or_create(&path).unwrap();
        assert_eq!(cfg.token, again.token);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reset_token_changes_token() {
        let dir =
            std::env::temp_dir().join(format!("remcontrol-test-reset-{}", std::process::id()));
        let path = dir.join("config.toml");
        let _ = std::fs::remove_dir_all(&dir);
        let cfg = Config::load_or_create(&path).unwrap();
        let reset = Config::reset_token(&path).unwrap();
        assert_ne!(cfg.token, reset.token);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn config_file_has_restricted_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("remcontrol-test-perm-{}", std::process::id()));
        let path = dir.join("config.toml");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = Config::load_or_create(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o077,
            0,
            "config file must not be group/world readable"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
