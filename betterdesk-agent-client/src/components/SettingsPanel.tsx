import { Component, createSignal, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t, setLocale, getLocale, getAvailableLocales } from "../lib/i18n";

interface AgentSettings {
  server_address: string;
  allow_remote: boolean;
  require_consent: boolean;
  allow_file_transfer: boolean;
  start_with_system: boolean;
  start_minimized: boolean;
  language: string;
}

const SettingsPanel: Component = () => {
  const [settings, setSettings] = createSignal<AgentSettings>({
    server_address: "",
    allow_remote: true,
    require_consent: false,
    allow_file_transfer: true,
    start_with_system: true,
    start_minimized: true,
    language: "en",
  });
  const [testResult, setTestResult] = createSignal<"ok" | "fail" | null>(null);
  const [version, setVersion] = createSignal("1.0.0");

  onMount(async () => {
    try {
      const s = await invoke<AgentSettings>("get_agent_settings");
      setSettings(s);
    } catch {}
    try {
      const v = await invoke<string>("get_agent_version");
      setVersion(v);
    } catch {}
  });

  const updateSetting = async <K extends keyof AgentSettings>(key: K, value: AgentSettings[K]) => {
    const updated = { ...settings(), [key]: value };
    setSettings(updated);
    try {
      await invoke("save_agent_settings", { settings: updated });
    } catch {}

    if (key === "language" && typeof value === "string") {
      setLocale(value);
    }
  };

  const testConnection = async () => {
    setTestResult(null);
    try {
      await invoke("test_server_connection", { address: settings().server_address });
      setTestResult("ok");
    } catch {
      setTestResult("fail");
    }
    setTimeout(() => setTestResult(null), 3000);
  };

  const restartService = async () => {
    try {
      await invoke("restart_agent_service");
    } catch {}
  };

  const unregister = async () => {
    const confirmed = confirm(t("settings.unregister_confirm"));
    if (!confirmed) return;
    try {
      await invoke("unregister_device");
      window.location.reload();
    } catch {}
  };

  return (
    <div class="page-content">
      <h2 class="page-title">{t("settings.title")}</h2>

      {/* Connection */}
      <section class="settings-section">
        <h3 class="settings-section-title">{t("settings.section_connection")}</h3>
        <div class="settings-row">
          <label class="form-label">{t("settings.server_address")}</label>
          <div class="settings-input-row">
            <input
              type="text"
              class="form-input"
              value={settings().server_address}
              onInput={(e) => updateSetting("server_address", e.currentTarget.value)}
            />
            <button class="btn btn-secondary btn-sm" onClick={testConnection}>
              {t("settings.test_connection")}
            </button>
          </div>
          <Show when={testResult() === "ok"}>
            <div class="form-success">{t("settings.connection_ok")}</div>
          </Show>
          <Show when={testResult() === "fail"}>
            <div class="form-error">{t("settings.connection_failed")}</div>
          </Show>
        </div>
      </section>

      {/* Privacy */}
      <section class="settings-section">
        <h3 class="settings-section-title">{t("settings.section_privacy")}</h3>

        <div class="settings-toggle-row">
          <div>
            <div class="settings-toggle-label">{t("settings.allow_remote")}</div>
            <div class="settings-toggle-hint">{t("settings.allow_remote_hint")}</div>
          </div>
          <label class="toggle-switch">
            <input
              type="checkbox"
              checked={settings().allow_remote}
              onChange={(e) => updateSetting("allow_remote", e.currentTarget.checked)}
            />
            <span class="toggle-slider" />
          </label>
        </div>

        <div class="settings-toggle-row">
          <div>
            <div class="settings-toggle-label">{t("settings.require_consent")}</div>
            <div class="settings-toggle-hint">{t("settings.require_consent_hint")}</div>
          </div>
          <label class="toggle-switch">
            <input
              type="checkbox"
              checked={settings().require_consent}
              onChange={(e) => updateSetting("require_consent", e.currentTarget.checked)}
            />
            <span class="toggle-slider" />
          </label>
        </div>

        <div class="settings-toggle-row">
          <div>
            <div class="settings-toggle-label">{t("settings.allow_file_transfer")}</div>
            <div class="settings-toggle-hint">{t("settings.allow_file_transfer_hint")}</div>
          </div>
          <label class="toggle-switch">
            <input
              type="checkbox"
              checked={settings().allow_file_transfer}
              onChange={(e) => updateSetting("allow_file_transfer", e.currentTarget.checked)}
            />
            <span class="toggle-slider" />
          </label>
        </div>
      </section>

      {/* General */}
      <section class="settings-section">
        <h3 class="settings-section-title">{t("settings.section_general")}</h3>

        <div class="settings-row">
          <label class="form-label">{t("settings.language")}</label>
          <select
            class="form-input form-select"
            value={getLocale()}
            onChange={(e) => updateSetting("language", e.currentTarget.value)}
          >
            {getAvailableLocales().map((loc) => (
              <option value={loc}>{loc === "en" ? "English" : loc === "pl" ? "Polski" : loc}</option>
            ))}
          </select>
        </div>

        <div class="settings-toggle-row">
          <div>
            <div class="settings-toggle-label">{t("settings.start_with_system")}</div>
          </div>
          <label class="toggle-switch">
            <input
              type="checkbox"
              checked={settings().start_with_system}
              onChange={(e) => updateSetting("start_with_system", e.currentTarget.checked)}
            />
            <span class="toggle-slider" />
          </label>
        </div>

        <div class="settings-toggle-row">
          <div>
            <div class="settings-toggle-label">{t("settings.start_minimized")}</div>
          </div>
          <label class="toggle-switch">
            <input
              type="checkbox"
              checked={settings().start_minimized}
              onChange={(e) => updateSetting("start_minimized", e.currentTarget.checked)}
            />
            <span class="toggle-slider" />
          </label>
        </div>
      </section>

      {/* About */}
      <section class="settings-section">
        <h3 class="settings-section-title">{t("settings.section_about")}</h3>
        <div class="settings-row">
          <span class="settings-about-label">{t("settings.app_version")}</span>
          <span class="settings-about-value">{version()}</span>
        </div>
        <div class="settings-actions">
          <button class="btn btn-secondary" onClick={restartService}>
            <span class="material-symbols-rounded">restart_alt</span>
            {t("settings.restart_service")}
          </button>
          <button class="btn btn-danger" onClick={unregister}>
            <span class="material-symbols-rounded">link_off</span>
            {t("settings.unregister")}
          </button>
        </div>
      </section>
    </div>
  );
};

export default SettingsPanel;
