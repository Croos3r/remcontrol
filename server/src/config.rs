use anyhow::Context;
use rand::distr::{Alphanumeric, SampleString};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DEFAULT_PORT: u16 = 17890;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub token: String,
    pub port: u16,
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
        std::fs::write(path, toml::to_string_pretty(self)?)?;
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
}
