import { Component, createSignal, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n";

interface AgentStatus {
  registered: boolean;
  connected: boolean;
  server_address: string;
  device_id: string;
  hostname: string;
  platform: string;
  version: string;
  uptime_secs: number;
  last_sync: string;
}

const StatusPanel: Component = () => {
  const [status, setStatus] = createSignal<AgentStatus | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [copyFeedback, setCopyFeedback] = createSignal(false);

  let pollInterval: ReturnType<typeof setInterval>;

  const fetchStatus = async () => {
    try {
      const s = await invoke<AgentStatus>("get_agent_status");
      setStatus(s);
    } catch {
      // Keep last known status
    }
    setLoading(false);
  };

  onMount(() => {
    fetchStatus();
    pollInterval = setInterval(fetchStatus, 5000);
  });

  onCleanup(() => clearInterval(pollInterval));

  const copyId = async () => {
    const s = status();
    if (!s) return;
    try {
      await invoke("copy_to_clipboard", { text: s.device_id });
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    } catch {}
  };

  const reconnect = async () => {
    try {
      await invoke("reconnect_agent");
      await fetchStatus();
    } catch {}
  };

  const sendDiagnostics = async () => {
    try {
      await invoke("send_diagnostics");
      // Show brief success indicator
    } catch {}
  };

  const formatUptime = (secs: number): string => {
    if (secs < 60) return `${secs}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m`;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return `${h}h ${m}m`;
  };

  return (
    <div class="page-content">
      <h2 class="page-title">{t("status.title")}</h2>

      {loading() ? (
        <div class="loading-state">
          <span class="material-symbols-rounded spin">sync</span>
          <span>{t("common.loading")}</span>
        </div>
      ) : (
        <>
          <div class="status-hero">
            <div class={`status-indicator ${status()?.connected ? "online" : "offline"}`}>
              <span class="material-symbols-rounded">
                {status()?.connected ? "cloud_done" : "cloud_off"}
              </span>
              <span class="status-text">
                {status()?.connected ? t("status.connected") : t("status.disconnected")}
              </span>
            </div>
          </div>

          <div class="info-grid">
            <div class="info-card">
              <div class="info-label">{t("status.device_id")}</div>
              <div class="info-value id-row">
                <code>{status()?.device_id || "—"}</code>
                <button class="icon-btn" onClick={copyId} title={t("status.copy_id")}>
                  <span class="material-symbols-rounded">
                    {copyFeedback() ? "check" : "content_copy"}
                  </span>
                </button>
              </div>
            </div>

            <div class="info-card">
              <div class="info-label">{t("status.server")}</div>
              <div class="info-value">{status()?.server_address || "—"}</div>
            </div>

            <div class="info-card">
              <div class="info-label">{t("status.hostname")}</div>
              <div class="info-value">{status()?.hostname || "—"}</div>
            </div>

            <div class="info-card">
              <div class="info-label">{t("status.platform")}</div>
              <div class="info-value">{status()?.platform || "—"}</div>
            </div>

            <div class="info-card">
              <div class="info-label">{t("status.version")}</div>
              <div class="info-value">{status()?.version || "—"}</div>
            </div>

            <div class="info-card">
              <div class="info-label">{t("status.uptime")}</div>
              <div class="info-value">
                {status()?.uptime_secs ? formatUptime(status()!.uptime_secs) : "—"}
              </div>
            </div>

            <div class="info-card">
              <div class="info-label">{t("status.last_sync")}</div>
              <div class="info-value">{status()?.last_sync || "—"}</div>
            </div>
          </div>

          <div class="status-actions">
            {!status()?.connected && (
              <button class="btn btn-primary" onClick={reconnect}>
                <span class="material-symbols-rounded">refresh</span>
                {t("status.reconnect")}
              </button>
            )}
            <button class="btn btn-secondary" onClick={sendDiagnostics}>
              <span class="material-symbols-rounded">bug_report</span>
              {t("status.send_diagnostics")}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default StatusPanel;
