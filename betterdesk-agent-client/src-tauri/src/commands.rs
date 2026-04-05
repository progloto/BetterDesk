use crate::config::AgentConfig;
use crate::registration;
use crate::sysinfo_collect::SystemSnapshot;
use log::info;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;

/// Shared application state managed by Tauri.
pub struct AgentState {
    pub config: Mutex<AgentConfig>,
    pub chat_history: Mutex<Vec<ChatMessage>>,
}

/// Chat message structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub sender: String,
    pub sender_type: String, // "user" or "operator"
    pub content: String,
    pub timestamp: String,
}

/// Agent status returned to the frontend.
#[derive(Serialize)]
pub struct AgentStatus {
    pub registered: bool,
    pub connected: bool,
    pub device_id: String,
    pub device_name: String,
    pub server_address: String,
    pub hostname: String,
    pub platform: String,
    pub version: String,
    pub uptime: String,
    pub last_sync: String,
}

/// Settings struct for frontend read/write.
#[derive(Debug, Serialize, Deserialize)]
pub struct AgentSettings {
    pub server_address: String,
    pub allow_remote: bool,
    pub require_consent: bool,
    pub allow_file_transfer: bool,
    pub language: String,
    pub autostart: bool,
    pub start_minimized: bool,
}

// ─────────────────────────── Status & Lifecycle ───────────────────────────

#[tauri::command]
pub fn get_agent_status(state: State<'_, AgentState>) -> Result<AgentStatus, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    let sysinfo = SystemSnapshot::collect();

    Ok(AgentStatus {
        registered: config.is_registered(),
        connected: config.is_registered(), // simplified: registered = connected
        device_id: config.device_id.clone(),
        device_name: config.device_name.clone(),
        server_address: config.server_address.clone(),
        hostname: sysinfo.hostname,
        platform: format!("{} {} ({})", sysinfo.os, sysinfo.os_version, sysinfo.arch),
        version: env!("CARGO_PKG_VERSION").to_string(),
        uptime: format_uptime(),
        last_sync: chrono::Utc::now().format("%Y-%m-%d %H:%M:%S UTC").to_string(),
    })
}

#[tauri::command]
pub async fn reconnect_agent(state: State<'_, AgentState>) -> Result<String, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;

    if !config.is_registered() {
        return Err("Device not registered".to_string());
    }

    // Send a heartbeat to verify connection.
    let address = config.server_address.clone();
    let device_id = config.device_id.clone();
    drop(config);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())?;

    let url = format_api_url(&address, "/heartbeat");
    let payload = serde_json::json!({ "id": device_id });

    client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Reconnect failed: {}", e))?;

    info!("Reconnect heartbeat sent for {}", device_id);
    Ok("Reconnected".to_string())
}

#[tauri::command]
pub async fn send_diagnostics(state: State<'_, AgentState>) -> Result<String, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;

    if !config.is_registered() {
        return Err("Device not registered".to_string());
    }

    let sysinfo = SystemSnapshot::collect();
    let address = config.server_address.clone();
    let device_id = config.device_id.clone();
    drop(config);

    let payload = serde_json::json!({
        "id": device_id,
        "hostname": sysinfo.hostname,
        "os": sysinfo.os,
        "version": sysinfo.os_version,
        "platform": format!("{} {}", sysinfo.os, sysinfo.arch),
        "cpu": sysinfo.cpu_name,
        "memory": format!("{} MB", sysinfo.total_memory_mb),
        "disk": format!("{} MB", sysinfo.total_disk_mb),
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())?;

    let url = format_api_url(&address, "/sysinfo");

    client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Diagnostics send failed: {}", e))?;

    info!("Diagnostics sent for {}", device_id);
    Ok("Diagnostics sent".to_string())
}

#[tauri::command]
pub fn get_agent_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub fn copy_to_clipboard(text: String) -> Result<(), String> {
    // Use Tauri's clipboard API via shell command fallback.
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("powershell")
            .args(["-Command", &format!("Set-Clipboard -Value '{}'", text.replace('\'', "''"))])
            .output()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        use std::io::Write;
        let mut child = std::process::Command::new("xclip")
            .args(["-selection", "clipboard"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .or_else(|_| {
                std::process::Command::new("xsel")
                    .args(["--clipboard", "--input"])
                    .stdin(std::process::Stdio::piped())
                    .spawn()
            })
            .map_err(|e| e.to_string())?;
        if let Some(stdin) = child.stdin.as_mut() {
            stdin.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        }
        child.wait().map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        use std::io::Write;
        let mut child = std::process::Command::new("pbcopy")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        if let Some(stdin) = child.stdin.as_mut() {
            stdin.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        }
        child.wait().map_err(|e| e.to_string())?;
    }

    Ok(())
}

// ─────────────────────────── Registration Flow ───────────────────────────

#[tauri::command]
pub async fn validate_server_step(
    address: String,
    step_key: String,
) -> Result<serde_json::Value, String> {
    let result = registration::validate_step(&address, &step_key).await;
    serde_json::to_value(&result).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn register_device(
    address: String,
    state: State<'_, AgentState>,
) -> Result<String, String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.server_address = address;

    let device_id = registration::register(&mut config)
        .await
        .map_err(|e| e.to_string())?;

    // Store token securely if available.
    if let Err(e) = config.store_token_secure() {
        info!("Keyring store skipped: {}", e);
    }

    Ok(device_id)
}

#[tauri::command]
pub async fn sync_initial_config(state: State<'_, AgentState>) -> Result<(), String> {
    let config = state.config.lock().map_err(|e| e.to_string())?.clone();

    registration::sync_config(&config)
        .await
        .map_err(|e| e.to_string())
}

// ─────────────────────────── Chat ───────────────────────────

#[tauri::command]
pub fn get_chat_history(state: State<'_, AgentState>) -> Result<Vec<ChatMessage>, String> {
    let history = state.chat_history.lock().map_err(|e| e.to_string())?;
    Ok(history.clone())
}

#[tauri::command]
pub async fn send_chat_message(
    message: String,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;

    if !config.is_registered() {
        return Err("Device not registered".to_string());
    }

    let msg = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        sender: config.device_name.clone(),
        sender_type: "user".to_string(),
        content: message,
        timestamp: chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string(),
    };

    drop(config);

    let mut history = state.chat_history.lock().map_err(|e| e.to_string())?;
    history.push(msg);

    // Cap history at 200 messages.
    if history.len() > 200 {
        let drain_count = history.len() - 200;
        history.drain(..drain_count);
    }

    Ok(())
}

// ─────────────────────────── Help Request ───────────────────────────

#[tauri::command]
pub async fn request_help(
    description: String,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;

    if !config.is_registered() {
        return Err("Device not registered".to_string());
    }

    let address = config.server_address.clone();
    let device_id = config.device_id.clone();
    let device_name = config.device_name.clone();
    drop(config);

    let payload = serde_json::json!({
        "device_id": device_id,
        "device_name": device_name,
        "description": description,
        "timestamp": chrono::Utc::now().to_rfc3339(),
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())?;

    let url = format_api_url(&address, "/bd/help-request");

    let resp = client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Help request failed: {}", e))?;

    if resp.status().is_success() {
        info!("Help request sent from {}", device_id);
        Ok(())
    } else {
        Err(format!("Server returned {}", resp.status()))
    }
}

#[tauri::command]
pub async fn cancel_help_request(state: State<'_, AgentState>) -> Result<(), String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;

    if !config.is_registered() {
        return Err("Device not registered".to_string());
    }

    let address = config.server_address.clone();
    let device_id = config.device_id.clone();
    drop(config);

    let payload = serde_json::json!({
        "device_id": device_id,
        "action": "cancel",
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())?;

    let url = format_api_url(&address, "/bd/help-request");

    let _ = client.delete(&url).json(&payload).send().await;
    info!("Help request cancelled for {}", device_id);
    Ok(())
}

// ─────────────────────────── Settings ───────────────────────────

#[tauri::command]
pub fn get_agent_settings(state: State<'_, AgentState>) -> Result<AgentSettings, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(AgentSettings {
        server_address: config.server_address.clone(),
        allow_remote: config.allow_remote,
        require_consent: config.require_consent,
        allow_file_transfer: config.allow_file_transfer,
        language: config.language.clone(),
        autostart: config.autostart,
        start_minimized: config.start_minimized,
    })
}

#[tauri::command]
pub fn save_agent_settings(
    settings: AgentSettings,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;

    config.server_address = settings.server_address;
    config.allow_remote = settings.allow_remote;
    config.require_consent = settings.require_consent;
    config.allow_file_transfer = settings.allow_file_transfer;
    config.language = settings.language;
    config.autostart = settings.autostart;
    config.start_minimized = settings.start_minimized;

    config.save().map_err(|e| e.to_string())?;
    info!("Settings saved");
    Ok(())
}

#[tauri::command]
pub async fn test_server_connection(address: String) -> Result<String, String> {
    let result = registration::validate_step(&address, "availability").await;

    if result.success {
        Ok("Connection successful".to_string())
    } else {
        Err(result.message)
    }
}

#[tauri::command]
pub fn restart_agent_service() -> Result<(), String> {
    info!("Agent service restart requested");
    // Re-exec is not trivially possible from within Tauri.
    // Signal the user to restart manually or implement platform-specific restart.
    Err("Please restart the application manually".to_string())
}

#[tauri::command]
pub fn unregister_device(state: State<'_, AgentState>) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;

    let old_id = config.device_id.clone();

    // Clear credentials from OS keyring.
    AgentConfig::clear_token_secure(&old_id);

    // Reset config to defaults.
    *config = AgentConfig::default();
    config.save().map_err(|e| e.to_string())?;

    info!("Device {} unregistered — config reset", old_id);
    Ok(())
}

// ─────────────────────────── Helpers ───────────────────────────

/// Format API URL from server address and path.
fn format_api_url(address: &str, path: &str) -> String {
    let addr = address.trim();
    let with_scheme = if addr.starts_with("http://") || addr.starts_with("https://") {
        addr.to_string()
    } else {
        format!("http://{}", addr)
    };

    if let Ok(parsed) = url::Url::parse(&with_scheme) {
        let host = parsed.host_str().unwrap_or("localhost");
        let port = parsed.port().unwrap_or(21114);
        let scheme = parsed.scheme();
        format!("{}://{}:{}/api{}", scheme, host, port, path)
    } else {
        format!("http://{}:21114/api{}", addr, path)
    }
}

/// Format system uptime as human-readable string.
fn format_uptime() -> String {
    let uptime_secs = sysinfo::System::uptime();
    let days = uptime_secs / 86400;
    let hours = (uptime_secs % 86400) / 3600;
    let minutes = (uptime_secs % 3600) / 60;

    if days > 0 {
        format!("{}d {}h {}m", days, hours, minutes)
    } else if hours > 0 {
        format!("{}h {}m", hours, minutes)
    } else {
        format!("{}m", minutes)
    }
}
