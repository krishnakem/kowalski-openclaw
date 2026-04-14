import { useContext } from "react";
import { SettingsContext, SettingsData, AnalysisStatus, DEFAULT_SETTINGS, SETTINGS_KEY } from "../contexts/SettingsContext";

// Re-export types for backward compatibility
export type { SettingsData, AnalysisStatus };
export { DEFAULT_SETTINGS, SETTINGS_KEY };

export const useSettings = () => {
  const context = useContext(SettingsContext);

  if (context === undefined) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }

  return context;
};

