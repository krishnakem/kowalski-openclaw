import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
    resetSession: () => ipcRenderer.invoke('reset-session'),
    clearInstagramSession: () => ipcRenderer.invoke('clear-instagram-session'),
    checkInstagramSession: () => ipcRenderer.invoke('check-instagram-session'),
    settings: {
        get: () => ipcRenderer.invoke('settings:get'),
        set: (value: any) => ipcRenderer.invoke('settings:set', value),
        patch: (updates: any) => ipcRenderer.invoke('settings:patch', updates),
        setSecure: (apiKey: string) => ipcRenderer.invoke('settings:set-secure', { apiKey }),
        checkKeyStatus: () => ipcRenderer.invoke('settings:check-key-status'),
        getSecureKey: () => ipcRenderer.invoke('settings:get-secure'),
        validateApiKey: (apiKey: string) => ipcRenderer.invoke('settings:validate-api-key', { apiKey }),
        onAnalysisReady: (callback: (analysis: any) => void) => {
            const subscription = (_event: any, analysis: any) => callback(analysis);
            ipcRenderer.on('analysis-ready', subscription);
            return () => ipcRenderer.removeListener('analysis-ready', subscription);
        },
        onAnalysisError: (callback: (error: { message: string; kind?: 'offline' | 'credits' | 'general'; canRetry: boolean; nextRetry?: string | null }) => void) => {
            const subscription = (_event: any, error: any) => callback(error);
            ipcRenderer.on('analysis-error', subscription);
            return () => ipcRenderer.removeListener('analysis-error', subscription);
        },
        onSessionExpired: (callback: () => void) => {
            const subscription = () => callback();
            ipcRenderer.on('instagram-session-expired', subscription);
            return () => ipcRenderer.removeListener('instagram-session-expired', subscription);
        },
        onRateLimited: (callback: (info: { nextRetry: string }) => void) => {
            const subscription = (_event: any, info: any) => callback(info);
            ipcRenderer.on('instagram-rate-limited', subscription);
            return () => ipcRenderer.removeListener('instagram-rate-limited', subscription);
        },
        onInsufficientContent: (callback: (info: { collected: number; required: number; reason: string; nextRetry: string }) => void) => {
            const subscription = (_event: any, info: any) => callback(info);
            ipcRenderer.on('analysis-insufficient-content', subscription);
            return () => ipcRenderer.removeListener('analysis-insufficient-content', subscription);
        },
        onRunStarted: (callback: (info: { durationMs: number; startTime: number }) => void) => {
            const subscription = (_event: any, info: any) => callback(info);
            ipcRenderer.on('run-started', subscription);
            return () => ipcRenderer.removeListener('run-started', subscription);
        },
        onRunComplete: (callback: () => void) => {
            const subscription = () => callback();
            ipcRenderer.on('run-complete', subscription);
            return () => ipcRenderer.removeListener('run-complete', subscription);
        },
        onRunPhase: (callback: (info: { phase: 'stories' | 'feed'; maxDurationMs?: number }) => void) => {
            const subscription = (_event: any, info: { phase: 'stories' | 'feed'; maxDurationMs?: number }) => callback(info);
            ipcRenderer.on('run-phase', subscription);
            return () => ipcRenderer.removeListener('run-phase', subscription);
        }
    },
    run: {
        start: () => ipcRenderer.invoke('run:start'),
        stop: () => ipcRenderer.invoke('run:stop'),
        skipToFeed: () => ipcRenderer.invoke('run:skipToFeed'),
        getStatus: () => ipcRenderer.invoke('run:status'),
    },
    network: {
        notifyOffline: () => ipcRenderer.send('network:offline'),
    },
    screencast: {
        onFrame: (cb: (data: string) => void): (() => void) => {

            const handler = (_event: any, data: string) => cb(data);
            ipcRenderer.on('kowalski:frame', handler);
            return () => {
                ipcRenderer.removeListener('kowalski:frame', handler);
            };
        },
        onEnded: (cb: () => void): (() => void) => {

            const handler = () => cb();
            ipcRenderer.on('kowalski:screencastEnded', handler);
            return () => {
                ipcRenderer.removeListener('kowalski:screencastEnded', handler);
            };
        },
    },
    analyses: {
        get: () => ipcRenderer.invoke('analyses:get'),
        set: (value: any) => ipcRenderer.invoke('analyses:set', value),
        getContent: (id: string) => ipcRenderer.invoke('analyses:get-content', id),
    },
    login: {
        startScreencast: () => ipcRenderer.invoke('login:startScreencast'),
        stopScreencast: () => ipcRenderer.invoke('login:stopScreencast'),
        onReady: (cb: () => void): (() => void) => {

            const handler = () => cb();
            ipcRenderer.on('kowalski:loginScreencastReady', handler);
            return () => ipcRenderer.removeListener('kowalski:loginScreencastReady', handler);
        },
        onSuccess: (cb: () => void): (() => void) => {

            const handler = () => cb();
            ipcRenderer.on('kowalski:loginSuccess', handler);
            return () => ipcRenderer.removeListener('kowalski:loginSuccess', handler);
        },
    },
    sendInput: (event: any) => ipcRenderer.send('kowalski:input', event),
    paste: (text?: string) => ipcRenderer.send('kowalski:paste', text),
    copySelection: () => ipcRenderer.send('kowalski:copySelection'),
});
