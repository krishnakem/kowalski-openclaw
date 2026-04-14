/// <reference types="vite/client" />

interface Window {
    api: {
        resetSession: () => Promise<boolean>;
        clearInstagramSession: () => Promise<boolean>;
        checkInstagramSession: () => Promise<{ isActive: boolean; reason: string }>;
        settings: {
            get: () => Promise<any>;
            set: (settings: any) => Promise<boolean>;
            patch: (updates: any) => Promise<any>;
            setSecure: (apiKey: string) => Promise<boolean>;
            checkKeyStatus: () => Promise<'locked' | 'secured' | 'missing'>;
            getSecureKey: () => Promise<string | null>;
            validateApiKey: (apiKey: string) => Promise<{ valid: boolean; error?: string }>;
            onAnalysisReady: (callback: (analysis: any) => void) => () => void;
            onAnalysisError: (callback: (error: { message: string; kind?: 'offline' | 'credits' | 'general'; canRetry: boolean; nextRetry?: string | null }) => void) => () => void;
            onSessionExpired: (callback: () => void) => () => void;
            onRateLimited: (callback: (info: { nextRetry: string }) => void) => () => void;
            onInsufficientContent: (callback: (info: { collected: number; required: number; reason: string; nextRetry: string }) => void) => () => void;
            onRunStarted: (callback: (info: { durationMs: number; startTime: number }) => void) => () => void;
            onRunComplete: (callback: () => void) => () => void;
            onRunPhase: (callback: (info: { phase: 'stories' | 'feed'; maxDurationMs?: number }) => void) => () => void;
        };
        run: {
            start: () => Promise<void>;
            stop: () => Promise<void>;
            skipToFeed: () => Promise<void>;
            getStatus: () => Promise<'idle' | 'running'>;
        };
        network: {
            notifyOffline: () => void;
        };
        screencast: {
            onFrame: (cb: (data: string) => void) => () => void;
            onEnded: (cb: () => void) => () => void;
        };
        analyses: {
            get: () => Promise<any[]>;
            set: (value: any[]) => Promise<boolean>;
            getContent: (id: string) => Promise<any | null>;
        };
        login: {
            startScreencast: () => Promise<void>;
            stopScreencast: () => Promise<void>;
            onReady: (cb: () => void) => () => void;
            onSuccess: (cb: () => void) => () => void;
        };
        sendInput: (event: any) => void;
        paste: (text?: string) => void;
        copySelection: () => void;
    }
}
