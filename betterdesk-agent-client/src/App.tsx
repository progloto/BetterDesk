import { Component, createSignal, onMount } from "solid-js";
import { Router, Route } from "@solidjs/router";
import StatusPanel from "./components/StatusPanel";
import SetupWizard from "./components/SetupWizard";
import ChatPanel from "./components/ChatPanel";
import HelpRequest from "./components/HelpRequest";
import SettingsPanel from "./components/SettingsPanel";
import Sidebar from "./components/Sidebar";
import { t, initI18n } from "./lib/i18n";
import { invoke } from "@tauri-apps/api/core";

const App: Component = () => {
  const [ready, setReady] = createSignal(false);
  const [registered, setRegistered] = createSignal(false);

  onMount(async () => {
    await initI18n();
    try {
      const status = await invoke<{ registered: boolean }>("get_agent_status");
      setRegistered(status.registered);
    } catch {
      setRegistered(false);
    }
    setReady(true);
  });

  return (
    <div class="app-root">
      {!ready() ? (
        <div class="app-loading">
          <span class="material-symbols-rounded spin">sync</span>
        </div>
      ) : !registered() ? (
        <SetupWizard onComplete={() => setRegistered(true)} />
      ) : (
        <div class="app-layout">
          <Sidebar />
          <main class="app-main">
            <Router>
              <Route path="/" component={StatusPanel} />
              <Route path="/chat" component={ChatPanel} />
              <Route path="/help" component={HelpRequest} />
              <Route path="/settings" component={SettingsPanel} />
            </Router>
          </main>
        </div>
      )}
    </div>
  );
};

export default App;
