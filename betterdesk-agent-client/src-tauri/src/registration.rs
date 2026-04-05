use anyhow::{anyhow, Result};
use log::info;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use url::Url;

use crate::config::AgentConfig;
use crate::sysinfo_collect::SystemSnapshot;

/// Result of a single validation step.
#[derive(Debug, Clone, Serialize)]
pub struct ValidationResult {
    pub step: String,
    pub success: bool,
    pub message: String,
}

/// Registration response from the server.
#[derive(Debug, Deserialize)]
struct RegisterResponse {
    #[serde(default)]
    device_id: String,
    #[serde(default)]
    token: String,
}

/// Sync response from the server.
#[derive(Debug, Deserialize)]
struct SyncResponse {
    #[serde(default)]
    status: String,
}

/// Build the base API URL from a server address string.
fn build_api_url(address: &str) -> Result<String> {
    let addr = address.trim();

    // If no scheme, prepend http://
    let with_scheme = if addr.starts_with("http://") || addr.starts_with("https://") {
        addr.to_string()
    } else {
        format!("http://{}", addr)
    };

    let parsed = Url::parse(&with_scheme).map_err(|e| anyhow!("Invalid URL: {}", e))?;

    // Default port is 21114 (API port)
    let host = parsed.host_str().ok_or_else(|| anyhow!("No host in URL"))?;
    let port = parsed.port().unwrap_or(21114);
    let scheme = parsed.scheme();

    Ok(format!("{}://{}:{}/api", scheme, host, port))
}

/// Validate a single step of the server connection.
pub async fn validate_step(address: &str, step_key: &str) -> ValidationResult {
    let result = match step_key {
        "availability" => check_availability(address).await,
        "protocol" => check_protocol(address).await,
        "registration" => check_registration_open(address).await,
        "certificate" => check_certificate(address).await,
        _ => Err(anyhow!("Unknown validation step: {}", step_key)),
    };

    match result {
        Ok(msg) => ValidationResult {
            step: step_key.to_string(),
            success: true,
            message: msg,
        },
        Err(e) => ValidationResult {
            step: step_key.to_string(),
            success: false,
            message: e.to_string(),
        },
    }
}

/// Step 1: Check if the server is reachable.
async fn check_availability(address: &str) -> Result<String> {
    let api_url = build_api_url(address)?;
    let url = format!("{}/server/stats", api_url);

    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .danger_accept_invalid_certs(true)
        .build()?;

    let resp = client.get(&url).send().await.map_err(|e| {
        anyhow!("Cannot reach server at {}: {}", address, e)
    })?;

    if resp.status().is_success() {
        Ok("Server is reachable".to_string())
    } else {
        Err(anyhow!("Server returned status {}", resp.status()))
    }
}

/// Step 2: Verify the server speaks BetterDesk protocol.
async fn check_protocol(address: &str) -> Result<String> {
    let api_url = build_api_url(address)?;
    let url = format!("{}/server/stats", api_url);

    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .danger_accept_invalid_certs(true)
        .build()?;

    let resp = client.get(&url).send().await?;
    let body: serde_json::Value = resp.json().await.map_err(|_| {
        anyhow!("Server response is not valid JSON — not a BetterDesk server")
    })?;

    // BetterDesk Go server /api/server/stats returns {"peers_count": N, ...}
    if body.get("peers_count").is_some() || body.get("version").is_some() {
        Ok("BetterDesk protocol confirmed".to_string())
    } else {
        Err(anyhow!("Server does not appear to be a BetterDesk server"))
    }
}

/// Step 3: Check if the server accepts new device registrations.
async fn check_registration_open(address: &str) -> Result<String> {
    let api_url = build_api_url(address)?;
    let url = format!("{}/login-options", api_url);

    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .danger_accept_invalid_certs(true)
        .build()?;

    let resp = client.get(&url).send().await;

    match resp {
        Ok(r) if r.status().is_success() => {
            Ok("Server accepts registrations".to_string())
        }
        Ok(r) if r.status().as_u16() == 403 => {
            Err(anyhow!("Server has closed registration"))
        }
        Ok(r) => {
            // Even if endpoint doesn't exist, registration via heartbeat works.
            info!("login-options returned {}, assuming open", r.status());
            Ok("Server accepts registrations".to_string())
        }
        Err(e) => {
            // Network error already caught by availability check — allow through.
            info!("login-options check failed: {}, assuming open", e);
            Ok("Server accepts registrations".to_string())
        }
    }
}

/// Step 4: Verify the TLS certificate (or accept self-signed with warning).
async fn check_certificate(address: &str) -> Result<String> {
    let api_url = build_api_url(address)?;
    let url = format!("{}/server/stats", api_url);

    // First try strict TLS validation.
    let strict_client = Client::builder()
        .timeout(Duration::from_secs(5))
        .build()?;

    match strict_client.get(&url).send().await {
        Ok(_) => return Ok("Valid TLS certificate".to_string()),
        Err(e) => {
            let err_str = e.to_string().to_lowercase();
            if err_str.contains("certificate") || err_str.contains("ssl") || err_str.contains("tls") {
                // Self-signed cert — allow with warning.
                return Ok("Self-signed certificate (accepted)".to_string());
            }

            // If it's HTTP (not HTTPS), no cert to validate.
            if api_url.starts_with("http://") {
                return Ok("Plain HTTP connection (no certificate required)".to_string());
            }

            Err(anyhow!("Certificate validation failed: {}", e))
        }
    }
}

/// Register this device with the BetterDesk server.
pub async fn register(config: &mut AgentConfig) -> Result<String> {
    let api_url = build_api_url(&config.server_address)?;
    let url = format!("{}/heartbeat", api_url);

    let sysinfo = SystemSnapshot::collect();
    let device_uid = machine_uid::get().unwrap_or_else(|_| uuid::Uuid::new_v4().to_string());

    // Generate a short device ID from machine UID hash.
    let id_hash = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(device_uid.as_bytes());
        let result = hasher.finalize();
        format!("BD-{}", hex_encode(&result[..4]).to_uppercase())
    };

    let payload = serde_json::json!({
        "id": id_hash,
        "uuid": device_uid,
        "hostname": sysinfo.hostname,
        "os": sysinfo.os,
        "version": sysinfo.os_version,
        "platform": format!("{} {}", sysinfo.os, sysinfo.arch),
        "device_type": "agent_client",
    });

    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .danger_accept_invalid_certs(true)
        .build()?;

    let resp = client.post(&url).json(&payload).send().await?;

    if resp.status().is_success() {
        config.device_id = id_hash.clone();
        config.device_name = sysinfo.hostname;
        config.registered = true;
        config.save()?;

        info!("Device registered as {}", id_hash);
        Ok(id_hash)
    } else {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        Err(anyhow!("Registration failed ({}): {}", status, body))
    }
}

/// Sync initial configuration from server after registration.
pub async fn sync_config(config: &AgentConfig) -> Result<()> {
    let api_url = build_api_url(&config.server_address)?;
    let url = format!("{}/sysinfo", api_url);

    let sysinfo = SystemSnapshot::collect();

    let payload = serde_json::json!({
        "id": config.device_id,
        "hostname": sysinfo.hostname,
        "os": sysinfo.os,
        "version": sysinfo.os_version,
        "platform": format!("{} {}", sysinfo.os, sysinfo.arch),
        "cpu": sysinfo.cpu_name,
        "memory": format!("{} MB", sysinfo.total_memory_mb),
    });

    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .danger_accept_invalid_certs(true)
        .build()?;

    let resp = client.post(&url).json(&payload).send().await?;

    if resp.status().is_success() {
        info!("Initial sysinfo synced for {}", config.device_id);
        Ok(())
    } else {
        let status = resp.status();
        info!("Sysinfo sync returned {} — continuing anyway", status);
        Ok(())
    }
}

/// Simple hex encoding for small slices.
fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}
