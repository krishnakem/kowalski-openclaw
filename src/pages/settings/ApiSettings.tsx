import { useState } from "react";
import { Eye, EyeOff, Loader2, Lock, Unlock, AlertTriangle } from "lucide-react";
import { motion } from "framer-motion";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useSettings } from "@/hooks/useSettings";
import { useFromScreen } from "@/hooks/useFromScreen";
import SettingsLayout from "@/components/layouts/SettingsLayout";

const ApiSettings = () => {
  const { navigateBack } = useFromScreen();
  const { settings, setSettings, saveSettings, keyStatus } = useSettings();
  const [showApiKey, setShowApiKey] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyChanged, setKeyChanged] = useState(false); // Track if API key was edited

  const handleSave = async () => {
    const apiKeyToSave = (settings.apiKey || "").trim();

    // Only validate if the user actually changed the API key
    if (keyChanged) {
      // Require a non-empty API key if user is trying to update it
      if (!apiKeyToSave) {
        setKeyError('Please enter an API key.');
        return;
      }

      // Validate the API key
      setIsValidating(true);
      setKeyError(null);

      try {
        const result = await window.api.settings.validateApiKey(apiKeyToSave);
        if (!result.valid) {
          setKeyError('Invalid API key. Please check and try again.');
          setIsValidating(false);
          return;
        }
      } catch (error) {
        console.error('API validation error:', error);
        setKeyError('Could not validate key. Check your connection.');
        setIsValidating(false);
        return;
      }

      setIsValidating(false);
    }

    // Save settings (apiKey will be included only if changed, or pass current)
    saveSettings({ ...settings, apiKey: keyChanged ? apiKeyToSave : settings.apiKey });
    toast.success("API Settings Saved");
    setKeyChanged(false); // Reset after save
  };

  return (
    <SettingsLayout title="API & Usage">
      {/* API Key */}
      <div className="space-y-3">
        <Label className="text-sm text-foreground font-sans">Anthropic API Key</Label>
        <div className="relative">
          <input
            key={showApiKey ? "text" : "password"} // Force re-render to ensure type switch works
            type={showApiKey ? "text" : "password"}
            value={settings.apiKey}
            onChange={(e) => {
              setSettings({ ...settings, apiKey: e.target.value });
              setKeyError(null);
              setKeyChanged(true); // Mark that the key was edited
            }}
            placeholder="sk-ant-..."
            autoComplete="off"
            autoCorrect="off"
            spellCheck="false"
            className={`w-full input-dotted text-foreground placeholder:text-foreground/30 text-left
                       font-sans text-lg tracking-wider pr-12 py-4 ${keyError ? 'border-destructive' : ''}`}
          />
          <div
            onClick={async (e) => {
              e.preventDefault();
              e.stopPropagation();

              if (!showApiKey) {
                // About to show key. If it's a placeholder, fetch the real one.
                const isPlaceholder = settings.apiKey === '••••••••••••••••';
                if (isPlaceholder || (keyStatus === 'secured' && !keyChanged)) {
                  try {
                    const realKey = await window.api.settings.getSecureKey();
                    if (realKey) {
                      setSettings({ ...settings, apiKey: realKey });
                    }
                  } catch (err: any) {
                    console.error("Unmask error:", err);
                    toast.error(`Error: ${err.message || "Failed to unmask"}`);
                  }
                }
              }

              setShowApiKey(prev => !prev);
            }}
            className="absolute right-0 top-1/2 -translate-y-1/2 p-3 text-muted-foreground transition-colors z-50 cursor-pointer hover:text-foreground"
          >
            {showApiKey ? <EyeOff size={20} /> : <Eye size={20} />}
          </div>
        </div>
        {keyError && (
          <motion.p
            initial={{ opacity: 0, y: -5 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-destructive text-sm font-sans text-center"
          >
            {keyError}
          </motion.p>
        )}
      </div>

      <button
        onClick={handleSave}
        disabled={isValidating}
        className={`w-full inline-flex items-center justify-center gap-3 px-8 py-4 border-2 border-foreground 
                   font-sans text-sm tracking-wider uppercase transition-all duration-200
                   ${isValidating
            ? 'text-foreground/50 cursor-not-allowed'
            : 'text-foreground hover:bg-foreground hover:text-background'}`}
      >
        {isValidating ? (
          <>
            <Loader2 size={16} className="animate-spin" />
            <span>Validating...</span>
          </>
        ) : (
          <span>Save</span>
        )}
      </button>
    </SettingsLayout>
  );
};

export default ApiSettings;
