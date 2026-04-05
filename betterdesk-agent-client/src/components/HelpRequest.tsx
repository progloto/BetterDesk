import { Component, createSignal, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n";

type HelpState = "idle" | "sending" | "sent" | "active";

const HelpRequest: Component = () => {
  const [state, setState] = createSignal<HelpState>("idle");
  const [message, setMessage] = createSignal("");
  const [error, setError] = createSignal("");

  const sendRequest = async () => {
    setState("sending");
    setError("");
    try {
      await invoke("request_help", { message: message().trim() });
      setState("sent");
      setMessage("");
    } catch (e) {
      setError(String(e));
      setState("idle");
    }
  };

  const cancelRequest = async () => {
    try {
      await invoke("cancel_help_request");
      setState("idle");
    } catch {}
  };

  return (
    <div class="page-content">
      <h2 class="page-title">{t("help.title")}</h2>

      {/* Idle — show form */}
      <Show when={state() === "idle"}>
        <div class="help-section">
          <p class="help-description">{t("help.description")}</p>

          <label class="form-label">{t("help.message_label")}</label>
          <textarea
            class="form-input form-textarea"
            placeholder={t("help.message_placeholder")}
            rows={4}
            value={message()}
            onInput={(e) => setMessage(e.currentTarget.value)}
          />

          <Show when={error()}>
            <div class="form-error">{error()}</div>
          </Show>

          <button class="btn btn-primary" onClick={sendRequest}>
            <span class="material-symbols-rounded">support_agent</span>
            {t("help.send")}
          </button>
        </div>
      </Show>

      {/* Sending */}
      <Show when={state() === "sending"}>
        <div class="help-status">
          <span class="material-symbols-rounded spin">sync</span>
          <p>{t("help.sending")}</p>
        </div>
      </Show>

      {/* Sent — waiting for operator */}
      <Show when={state() === "sent"}>
        <div class="help-status sent">
          <span class="material-symbols-rounded">notifications_active</span>
          <h3>{t("help.sent_title")}</h3>
          <p>{t("help.sent_message")}</p>
          <button class="btn btn-secondary" onClick={cancelRequest}>
            <span class="material-symbols-rounded">close</span>
            {t("help.cancel")}
          </button>
        </div>
      </Show>

      {/* Active session */}
      <Show when={state() === "active"}>
        <div class="help-status active">
          <span class="material-symbols-rounded">person</span>
          <h3>{t("help.active_title")}</h3>
          <p>{t("help.active_message")}</p>
        </div>
      </Show>
    </div>
  );
};

export default HelpRequest;
