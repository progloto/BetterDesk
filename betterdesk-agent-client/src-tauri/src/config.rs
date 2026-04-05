use anyhow::Result;
use log::info;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Persistent agent configuration stored as JSON on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Server address (e.g., "192.168.0.110:21116" or "betterdesk.example.com").
    pub server_address: String,

    /// Unique device identifier assigned during registration.
    pub device_id: String,

    /// Device display name (defaults to hostname).
    pub device_name: String,

    /// Authentication token received from server during registration.
    pub auth_token: String,

    /// Whether the device has completed registration.
    pub registered: bool,

    /// Privacy: allow remote desktop connections.
    pub allow_remote: bool,

    /// Privacy: require user consent before remote session starts.
    pub require_consent: bool,

    /// Privacy: allow file transfers.
    pub allow_file_transfer: bool,

    /// General: start application on system boot.
    pub autostart: bool,

    /// General: start minimized to tray.
    pub start_minimized: bool,

    /// UI language code ("en" or "pl").
    pub language: String,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            server_address: String::new(),
            device_id: String::new(),
            device_name: hostname::get()
                .map(|h| h.to_string_lossy().to_string())
                .unwrap_or_else(|_| "unknown".to_string()),
            auth_token: String::new(),
            registered: false,
            allow_remote: true,
            require_consent: true,
            allow_file_transfer: true,
            autostart: true,
            start_minimized: true,
            language: "en".to_string(),
        }
    }
}

impl AgentConfig {
    /// Configuration file path.
    fn config_path() -> PathBuf {
        let dir = directories::ProjectDirs::from("com", "betterdesk", "agent")
            .map(|d| d.config_dir().to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        dir.join("agent-config.json")
    }

    /// Load config from disk. Returns default if file doesn't exist.
    pub fn load() -> Result<Self> {
        let path = Self::config_path();
        if !path.exists() {
            info!("No config file at {:?} — using defaults", path);
            return Ok(Self::default());
        }

        let content = std::fs::read_to_string(&path)?;
        let config: Self = serde_json::from_str(&content)?;
        Ok(config)
    }

    /// Persist config to disk.
    pub fn save(&self) -> Result<()> {
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let content = serde_json::to_string_pretty(self)?;
        std::fs::write(&path, content)?;
        info!("Config saved to {:?}", path);
        Ok(())
    }

    /// Whether this device has completed registration with a server.
    pub fn is_registered(&self) -> bool {
        self.registered && !self.device_id.is_empty() && !self.server_address.is_empty()
    }

    /// Store credentials securely via OS keyring.
    pub fn store_token_secure(&self) -> Result<()> {
        if self.auth_token.is_empty() {
            return Ok(());
        }
        let entry = keyring::Entry::new("betterdesk-agent", &self.device_id)?;
        entry.set_password(&self.auth_token)?;
        info!("Auth token stored in OS keyring");
        Ok(())
    }

    /// Retrieve token from OS keyring.
    pub fn load_token_secure(device_id: &str) -> Option<String> {
        keyring::Entry::new("betterdesk-agent", device_id)
            .ok()
            .and_then(|e| e.get_password().ok())
    }

    /// Delete token from OS keyring.
    pub fn clear_token_secure(device_id: &str) {
        if let Ok(entry) = keyring::Entry::new("betterdesk-agent", device_id) {
            let _ = entry.delete_credential();
        }
    }
}
