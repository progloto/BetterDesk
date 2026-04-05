use serde::Serialize;
use sysinfo::System;

/// System information snapshot for registration and diagnostics.
#[derive(Debug, Clone, Serialize)]
pub struct SystemSnapshot {
    pub hostname: String,
    pub os: String,
    pub os_version: String,
    pub arch: String,
    pub cpu_name: String,
    pub cpu_cores: usize,
    pub total_memory_mb: u64,
    pub total_disk_mb: u64,
    pub username: String,
}

impl SystemSnapshot {
    /// Collect current system information.
    pub fn collect() -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();

        let cpu_name = sys
            .cpus()
            .first()
            .map(|c| c.brand().to_string())
            .unwrap_or_else(|| "Unknown".to_string());

        let total_disk_mb: u64 = sysinfo::Disks::new_with_refreshed_list()
            .iter()
            .map(|d| d.total_space() / 1_048_576)
            .sum();

        Self {
            hostname: hostname::get()
                .map(|h| h.to_string_lossy().to_string())
                .unwrap_or_else(|_| "unknown".to_string()),
            os: System::name().unwrap_or_else(|| std::env::consts::OS.to_string()),
            os_version: System::os_version().unwrap_or_else(|| "unknown".to_string()),
            arch: std::env::consts::ARCH.to_string(),
            cpu_name,
            cpu_cores: sys.cpus().len(),
            total_memory_mb: sys.total_memory() / 1_048_576,
            total_disk_mb,
            username: whoami::username(),
        }
    }
}
