// src/preload/preload.cts
var import_electron = require("electron");
import_electron.contextBridge.exposeInMainWorld("api", {
  resetSession: () => import_electron.ipcRenderer.invoke("reset-session"),
  clearInstagramSession: () => import_electron.ipcRenderer.invoke("clear-instagram-session"),
  checkInstagramSession: () => import_electron.ipcRenderer.invoke("check-instagram-session"),
  settings: {
    get: () => import_electron.ipcRenderer.invoke("settings:get"),
    set: (value) => import_electron.ipcRenderer.invoke("settings:set", value),
    patch: (updates) => import_electron.ipcRenderer.invoke("settings:patch", updates),
    setSecure: (apiKey) => import_electron.ipcRenderer.invoke("settings:set-secure", { apiKey }),
    checkKeyStatus: () => import_electron.ipcRenderer.invoke("settings:check-key-status"),
    getSecureKey: () => import_electron.ipcRenderer.invoke("settings:get-secure"),
    validateApiKey: (apiKey) => import_electron.ipcRenderer.invoke("settings:validate-api-key", { apiKey }),
    onAnalysisReady: (callback) => {
      const subscription = (_event, analysis) => callback(analysis);
      import_electron.ipcRenderer.on("analysis-ready", subscription);
      return () => import_electron.ipcRenderer.removeListener("analysis-ready", subscription);
    },
    onAnalysisError: (callback) => {
      const subscription = (_event, error) => callback(error);
      import_electron.ipcRenderer.on("analysis-error", subscription);
      return () => import_electron.ipcRenderer.removeListener("analysis-error", subscription);
    },
    onSessionExpired: (callback) => {
      const subscription = () => callback();
      import_electron.ipcRenderer.on("instagram-session-expired", subscription);
      return () => import_electron.ipcRenderer.removeListener("instagram-session-expired", subscription);
    },
    onRateLimited: (callback) => {
      const subscription = (_event, info) => callback(info);
      import_electron.ipcRenderer.on("instagram-rate-limited", subscription);
      return () => import_electron.ipcRenderer.removeListener("instagram-rate-limited", subscription);
    },
    onInsufficientContent: (callback) => {
      const subscription = (_event, info) => callback(info);
      import_electron.ipcRenderer.on("analysis-insufficient-content", subscription);
      return () => import_electron.ipcRenderer.removeListener("analysis-insufficient-content", subscription);
    },
    onRunStarted: (callback) => {
      const subscription = (_event, info) => callback(info);
      import_electron.ipcRenderer.on("run-started", subscription);
      return () => import_electron.ipcRenderer.removeListener("run-started", subscription);
    },
    onRunComplete: (callback) => {
      const subscription = () => callback();
      import_electron.ipcRenderer.on("run-complete", subscription);
      return () => import_electron.ipcRenderer.removeListener("run-complete", subscription);
    },
    onRunPhase: (callback) => {
      const subscription = (_event, info) => callback(info);
      import_electron.ipcRenderer.on("run-phase", subscription);
      return () => import_electron.ipcRenderer.removeListener("run-phase", subscription);
    }
  },
  run: {
    start: () => import_electron.ipcRenderer.invoke("run:start"),
    stop: () => import_electron.ipcRenderer.invoke("run:stop"),
    skipToFeed: () => import_electron.ipcRenderer.invoke("run:skipToFeed"),
    getStatus: () => import_electron.ipcRenderer.invoke("run:status")
  },
  network: {
    notifyOffline: () => import_electron.ipcRenderer.send("network:offline")
  },
  screencast: {
    onFrame: (cb) => {
      const handler = (_event, data) => cb(data);
      import_electron.ipcRenderer.on("kowalski:frame", handler);
      return () => {
        import_electron.ipcRenderer.removeListener("kowalski:frame", handler);
      };
    },
    onEnded: (cb) => {
      const handler = () => cb();
      import_electron.ipcRenderer.on("kowalski:screencastEnded", handler);
      return () => {
        import_electron.ipcRenderer.removeListener("kowalski:screencastEnded", handler);
      };
    }
  },
  analyses: {
    get: () => import_electron.ipcRenderer.invoke("analyses:get"),
    set: (value) => import_electron.ipcRenderer.invoke("analyses:set", value),
    getContent: (id) => import_electron.ipcRenderer.invoke("analyses:get-content", id)
  },
  login: {
    startScreencast: () => import_electron.ipcRenderer.invoke("login:startScreencast"),
    stopScreencast: () => import_electron.ipcRenderer.invoke("login:stopScreencast"),
    onReady: (cb) => {
      const handler = () => cb();
      import_electron.ipcRenderer.on("kowalski:loginScreencastReady", handler);
      return () => import_electron.ipcRenderer.removeListener("kowalski:loginScreencastReady", handler);
    },
    onSuccess: (cb) => {
      const handler = () => cb();
      import_electron.ipcRenderer.on("kowalski:loginSuccess", handler);
      return () => import_electron.ipcRenderer.removeListener("kowalski:loginSuccess", handler);
    }
  },
  sendInput: (event) => import_electron.ipcRenderer.send("kowalski:input", event),
  paste: (text) => import_electron.ipcRenderer.send("kowalski:paste", text),
  copySelection: () => import_electron.ipcRenderer.send("kowalski:copySelection")
});
//# sourceMappingURL=preload.cjs.map
