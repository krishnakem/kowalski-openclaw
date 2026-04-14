/**
 * Secure storage utilities for sensitive data.
 * API keys are stored in sessionStorage (cleared when browser closes)
 * to reduce exposure risk compared to localStorage.
 */

const SECURE_KEY = "kowalski-secure";

interface SecureData {
  apiKey?: string;
}

/**
 * Get secure data from sessionStorage
 */
export const getSecureData = (): SecureData => {
  try {
    const stored = sessionStorage.getItem(SECURE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error("Failed to parse secure data:", e);
  }
  return {};
};

/**
 * Set secure data in sessionStorage
 */
export const setSecureData = (data: Partial<SecureData>): void => {
  try {
    const existing = getSecureData();
    const merged = { ...existing, ...data };
    sessionStorage.setItem(SECURE_KEY, JSON.stringify(merged));
  } catch (e) {
    console.error("Failed to save secure data:", e);
  }
};

/**
 * Clear all secure data
 */
export const clearSecureData = (): void => {
  sessionStorage.removeItem(SECURE_KEY);
};

/**
 * Get API key from secure storage
 */
export const getApiKey = (): string => {
  return getSecureData().apiKey || "";
};

/**
 * Set API key in secure storage
 */
export const setApiKey = (apiKey: string): void => {
  setSecureData({ apiKey });
};
