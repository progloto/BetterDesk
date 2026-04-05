//! BetterDesk Agent Client — lightweight endpoint device agent.
//!
//! Architecture:
//! - `config`          — Persistent settings (server address, device identity, preferences)
//! - `registration`    — Multi-step server validation and device registration flow
//! - `sysinfo_collect` — System information collection (hostname, OS, CPU, RAM, disk)
//! - `commands`        — Tauri IPC commands exposed to the frontend

pub mod commands;
pub mod config;
pub mod registration;
pub mod sysinfo_collect;

use log::info;
use std::sync::Mutex;
use tauri::Manager;

/// Entry point — called from main.rs.
pub fn run() {
    let is_console = std::env::args().any(|a| a == "--console");
    let default_level = if is_console { "debug" } else { "info" };

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or(default_level))
        .format_timestamp_millis()
        .init();

    info!(
        "BetterDesk Agent v{} (pid={}) — boot",
        env!("CARGO_PKG_VERSION"),
        std::process::id()
    );

    let settings = config::AgentConfig::load().unwrap_or_default();
    let is_registered = settings.is_registered();

    info!(
        "Config loaded — registered: {}, server: {:?}",
        is_registered,
        settings.server_address
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            info!("Second instance detected — bringing existing window to front");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(commands::AgentState {
            config: Mutex::new(settings),
            chat_history: Mutex::new(Vec::new()),
        })
        .invoke_handler(tauri::generate_handler![
            // Status & lifecycle
            commands::get_agent_status,
            commands::reconnect_agent,
            commands::send_diagnostics,
            commands::get_agent_version,
            commands::copy_to_clipboard,
            // Registration flow
            commands::validate_server_step,
            commands::register_device,
            commands::sync_initial_config,
            // Chat
            commands::get_chat_history,
            commands::send_chat_message,
            // Help request
            commands::request_help,
            commands::cancel_help_request,
            // Settings
            commands::get_agent_settings,
            commands::save_agent_settings,
            commands::test_server_connection,
            commands::restart_agent_service,
            commands::unregister_device,
        ])
        .setup(move |app| {
            info!("Tauri setup complete");

            // Tray icon — always visible, minimal.
            setup_tray(app.handle())?;

            // Hide main window on startup if autostart mode.
            if std::env::args().any(|a| a == "--autostart") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Minimize to tray on close instead of exiting.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("Failed to start BetterDesk Agent");
}

/// Minimal system tray setup.
fn setup_tray(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::TrayIconBuilder;

    let show = MenuItemBuilder::with_id("show", "Show").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let menu = MenuBuilder::new(app).item(&show).separator().item(&quit).build()?;

    let _tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("BetterDesk Agent")
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                info!("Quit requested from tray");
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}
