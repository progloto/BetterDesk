import { Component, createSignal, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n";

interface ValidationStep {
  key: string;
  label: string;
  status: "pending" | "running" | "ok" | "error";
  error?: string;
}

interface SetupProps {
  onComplete: () => void;
}

const SetupWizard: Component<SetupProps> = (props) => {
  const [step, setStep] = createSignal(0); // 0=address, 1=validate, 2=register, 3=sync, 4=complete
  const [address, setAddress] = createSignal("");
  const [addressError, setAddressError] = createSignal("");
  const [validationSteps, setValidationSteps] = createSignal<ValidationStep[]>([]);
  const [registering, setRegistering] = createSignal(false);
  const [registerError, setRegisterError] = createSignal("");
  const [syncing, setSyncing] = createSignal(false);
  const [syncError, setSyncError] = createSignal("");

  const validateAddress = (): boolean => {
    const addr = address().trim();
    if (!addr) {
      setAddressError(t("setup.error_empty"));
      return false;
    }
    // Basic format check: hostname, IP, or hostname:port
    const pattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(:\d{1,5})?$/;
    if (!pattern.test(addr)) {
      setAddressError(t("setup.error_format"));
      return false;
    }
    setAddressError("");
    return true;
  };

  const startValidation = async () => {
    if (!validateAddress()) return;

    setStep(1);
    const steps: ValidationStep[] = [
      { key: "availability", label: t("setup.checking_availability"), status: "pending" },
      { key: "protocol", label: t("setup.checking_protocol"), status: "pending" },
      { key: "registration", label: t("setup.checking_registration"), status: "pending" },
      { key: "certificate", label: t("setup.checking_certificate"), status: "pending" },
    ];
    setValidationSteps([...steps]);

    for (let i = 0; i < steps.length; i++) {
      steps[i].status = "running";
      setValidationSteps([...steps]);

      try {
        await invoke("validate_server_step", {
          address: address().trim(),
          stepKey: steps[i].key,
        });
        steps[i].status = "ok";
      } catch (e) {
        steps[i].status = "error";
        steps[i].error = String(e);
        setValidationSteps([...steps]);
        return; // Stop on first failure
      }
      setValidationSteps([...steps]);
    }

    // Auto-proceed to registration after brief pause
    setTimeout(() => setStep(2), 800);
  };

  const startRegistration = async () => {
    setRegistering(true);
    setRegisterError("");
    try {
      await invoke("register_device", { address: address().trim() });
      setStep(3);
      await startSync();
    } catch (e) {
      setRegisterError(String(e));
    }
    setRegistering(false);
  };

  const startSync = async () => {
    setSyncing(true);
    setSyncError("");
    try {
      await invoke("sync_initial_config");
      setStep(4);
    } catch (e) {
      setSyncError(String(e));
    }
    setSyncing(false);
  };

  return (
    <div class="setup-root">
      <div class="setup-card">
        <div class="setup-header">
          <span class="material-symbols-rounded setup-icon">lan</span>
          <h1>{t("setup.title")}</h1>
          <p class="setup-subtitle">{t("setup.subtitle")}</p>
        </div>

        {/* Step indicators */}
        <div class="setup-steps">
          {["step_address", "step_validate", "step_register", "step_sync", "step_complete"].map(
            (sk, idx) => (
              <div class={`setup-step-dot ${step() >= idx ? "active" : ""} ${step() === idx ? "current" : ""}`}>
                <span>{idx + 1}</span>
              </div>
            )
          )}
        </div>

        {/* Step 0: Address input */}
        <Show when={step() === 0}>
          <div class="setup-body">
            <label class="form-label">{t("setup.server_address")}</label>
            <input
              type="text"
              class={`form-input ${addressError() ? "error" : ""}`}
              placeholder={t("setup.server_placeholder")}
              value={address()}
              onInput={(e) => {
                setAddress(e.currentTarget.value);
                setAddressError("");
              }}
              onKeyDown={(e) => e.key === "Enter" && startValidation()}
            />
            <Show when={addressError()}>
              <div class="form-error">{addressError()}</div>
            </Show>
            <button class="btn btn-primary setup-next" onClick={startValidation}>
              {t("setup.next")}
              <span class="material-symbols-rounded">arrow_forward</span>
            </button>
          </div>
        </Show>

        {/* Step 1: Validation */}
        <Show when={step() === 1}>
          <div class="setup-body">
            <p class="setup-progress-label">{t("setup.validating")}</p>
            <div class="validation-list">
              <For each={validationSteps()}>
                {(vs) => (
                  <div class={`validation-item ${vs.status}`}>
                    <span class="material-symbols-rounded validation-icon">
                      {vs.status === "pending"
                        ? "radio_button_unchecked"
                        : vs.status === "running"
                        ? "sync"
                        : vs.status === "ok"
                        ? "check_circle"
                        : "cancel"}
                    </span>
                    <span class="validation-label">{vs.label}</span>
                    <Show when={vs.error}>
                      <span class="validation-error">{vs.error}</span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
            <Show when={validationSteps().some((v) => v.status === "error")}>
              <button class="btn btn-secondary" onClick={() => setStep(0)}>
                <span class="material-symbols-rounded">arrow_back</span>
                {t("setup.back")}
              </button>
            </Show>
          </div>
        </Show>

        {/* Step 2: Registration */}
        <Show when={step() === 2}>
          <div class="setup-body">
            <Show when={!registering()} fallback={
              <div class="setup-progress">
                <span class="material-symbols-rounded spin">sync</span>
                <p>{t("setup.registering")}</p>
              </div>
            }>
              <Show when={registerError()} fallback={
                <button class="btn btn-primary" onClick={startRegistration}>
                  {t("setup.step_register")}
                  <span class="material-symbols-rounded">arrow_forward</span>
                </button>
              }>
                <div class="setup-error">
                  <span class="material-symbols-rounded">error</span>
                  <p>{registerError()}</p>
                </div>
                <button class="btn btn-secondary" onClick={() => { setRegisterError(""); startRegistration(); }}>
                  {t("setup.step_register")}
                </button>
              </Show>
            </Show>
          </div>
        </Show>

        {/* Step 3: Sync */}
        <Show when={step() === 3}>
          <div class="setup-body">
            <Show when={syncing()} fallback={
              <Show when={syncError()}>
                <div class="setup-error">
                  <span class="material-symbols-rounded">error</span>
                  <p>{syncError()}</p>
                </div>
                <button class="btn btn-secondary" onClick={startSync}>
                  {t("setup.step_sync")}
                </button>
              </Show>
            }>
              <div class="setup-progress">
                <span class="material-symbols-rounded spin">sync</span>
                <p>{t("setup.syncing")}</p>
              </div>
            </Show>
          </div>
        </Show>

        {/* Step 4: Complete */}
        <Show when={step() === 4}>
          <div class="setup-body setup-complete">
            <span class="material-symbols-rounded complete-icon">check_circle</span>
            <h2>{t("setup.complete_title")}</h2>
            <p>{t("setup.complete_message")}</p>
            <button class="btn btn-primary" onClick={props.onComplete}>
              {t("setup.finish")}
              <span class="material-symbols-rounded">arrow_forward</span>
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default SetupWizard;
