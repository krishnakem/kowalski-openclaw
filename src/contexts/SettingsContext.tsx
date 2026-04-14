import React, { createContext, useState, useEffect, useCallback, ReactNode } from "react";
import { z } from "zod";

// --- Types & Defaults (Moved from useSettings.ts) ---

export const SETTINGS_KEY = "kowalski-settings";

export type AnalysisStatus = "idle" | "working" | "ready";

export interface SettingsData {
    userName: string;
    apiKey: string;
    hasOnboarded: boolean;
    analysisStatus: AnalysisStatus;
    lastAnalysisDate?: string;
    location: string;
}

export const DEFAULT_SETTINGS: SettingsData = {
    userName: "",
    apiKey: "",
    hasOnboarded: false,
    analysisStatus: "idle",
    location: "Cupertino",
};

// Zod schema for validation and coercion
const settingsSchema = z.object({
    userName: z.string().catch(""),
    apiKey: z.string().catch(""),
    hasOnboarded: z.boolean().catch(false),
    analysisStatus: z.enum(["idle", "working", "ready"]).catch("idle"),
    lastAnalysisDate: z.string().optional(),
    location: z.string().catch(""),
});

const normalizeSettings = (raw: unknown): SettingsData => {
    const parsed = settingsSchema.safeParse(raw);
    if (parsed.success) {
        return { ...DEFAULT_SETTINGS, ...parsed.data };
    }
    return DEFAULT_SETTINGS;
};

const separateApiKey = (data: SettingsData): { apiKey: string; rest: Omit<SettingsData, 'apiKey'> & { apiKey: '' } } => {
    const { apiKey, ...rest } = data;
    return { apiKey, rest: { ...rest, apiKey: '' } };
};

// --- Context Definition ---

interface SettingsContextValue {
    settings: SettingsData;
    setSettings: (settings: SettingsData) => void;
    saveSettings: (newSettings?: SettingsData) => Promise<void>;
    resetSettings: () => Promise<void>;
    patchSettings: (updates: Partial<SettingsData>) => Promise<void>;
    isLoaded: boolean;
    keyStatus: 'locked' | 'secured' | 'missing';
}

export const SettingsContext = createContext<SettingsContextValue | undefined>(undefined);

// --- Provider Implementation ---

export const SettingsProvider = ({ children }: { children: ReactNode }) => {
    const [settings, setSettings] = useState<SettingsData>(DEFAULT_SETTINGS);
    const [isLoaded, setIsLoaded] = useState(false);
    const [keyStatus, setKeyStatus] = useState<'locked' | 'secured' | 'missing'>('missing');

    useEffect(() => {
        const loadSettings = async () => {
            try {
                // Load non-sensitive settings from electron-store (async)
                const saved = await window.api.settings.get();
                let loadedSettings = DEFAULT_SETTINGS;

                if (saved && Object.keys(saved).length > 0) {
                    loadedSettings = normalizeSettings(saved);
                }

                // Check Secure Key Status
                const status = await window.api.settings.checkKeyStatus();
                setKeyStatus(status);

                // If secured, set a placeholder so form validation passes (if any)
                // But do NOT expose the real key.
                const apiKeyPlaceholder = status === 'secured' ? '••••••••••••••••' : '';

                setSettings({ ...loadedSettings, apiKey: apiKeyPlaceholder });
            } catch (e) {
                console.error("Failed to load settings:", e);
            } finally {
                setIsLoaded(true);
            }
        };

        loadSettings();
    }, []);

    const saveSettings = async (newSettings?: SettingsData) => {
        const toSave = newSettings || settings;
        const { apiKey, rest } = separateApiKey(toSave);

        // Save non-sensitive data to electron-store
        await window.api.settings.set(rest);

        // Handle Secure Key
        if (apiKey && apiKey !== '••••••••••••••••') {
            await window.api.settings.setSecure(apiKey);
            setKeyStatus('secured');
        }

        if (newSettings) setSettings(newSettings);
    };

    const resetSettings = async () => {
        // Reset electron-store (this also clears activeSchedule in main.ts handler)
        await window.api.settings.set(separateApiKey(DEFAULT_SETTINGS).rest);
        // Overwrite secure key with empty string effectively clearing it
        await window.api.settings.setSecure("");
        setKeyStatus('missing');
        setSettings(DEFAULT_SETTINGS);
    };

    /**
     * Patch settings with partial updates - merges with existing settings and saves.
     * Useful for incremental saves during onboarding.
     */
    const patchSettings = useCallback(async (updates: Partial<SettingsData>) => {
        // Optimistic update
        setSettings(prev => {
            return normalizeSettings({ ...prev, ...updates });
        });

        // Handle Secure Key Update
        if ('apiKey' in updates && updates.apiKey && updates.apiKey !== '••••••••••••••••') {
            await window.api.settings.setSecure(updates.apiKey);
            setKeyStatus('secured');
        }

        // Strip apiKey from updates sent to store
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { apiKey: _, ...restUpdates } = updates;

        if (Object.keys(restUpdates).length > 0) {
            await window.api.settings.patch(restUpdates);
        }
    }, []);

    const value = {
        settings,
        setSettings,
        saveSettings,
        resetSettings,
        patchSettings,
        isLoaded,
        keyStatus
    };

    return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
};
