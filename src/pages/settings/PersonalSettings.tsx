import { useState, useEffect } from "react";
import { MapPin, Loader2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { useSettings } from "@/hooks/useSettings";
import SettingsLayout from "@/components/layouts/SettingsLayout";

const PersonalSettings = () => {
  const navigate = useNavigate();
  const { settings, isLoaded, patchSettings } = useSettings();

  const [editName, setEditName] = useState("");
  const [editLocation, setEditLocation] = useState("");
  const [isDetectingLocation, setIsDetectingLocation] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<{ isActive: boolean; reason?: string } | null>(null);
  const [isCheckingSession, setIsCheckingSession] = useState(true);

  // Sync state when settings are loaded
  useEffect(() => {
    if (isLoaded) {
      console.log("Settings loaded:", { userName: settings.userName, location: settings.location });
      setEditName(settings.userName);
      setEditLocation(settings.location);
    }
  }, [isLoaded, settings.userName, settings.location]);

  // Check Instagram session status on mount
  const checkSessionStatus = async () => {
    try {
      setIsCheckingSession(true);
      // @ts-ignore
      const status = await window.api.checkInstagramSession();
      console.log("Session status:", status);
      setSessionStatus(status);
    } catch (e) {
      console.error("Failed to check session:", e);
      setSessionStatus({ isActive: false, reason: "error" });
    } finally {
      setIsCheckingSession(false);
    }
  };

  useEffect(() => {
    checkSessionStatus();
  }, []);

  const handleSave = () => {
    patchSettings({ userName: editName, location: editLocation });
    toast.success("Personal info saved");
  };

  const handleDetectLocation = async () => {
    setIsDetectingLocation(true);

    try {
      // Use IP-based geolocation for Electron compatibility
      // This doesn't require GPS permissions and works reliably
      const response = await fetch('https://ipapi.co/json/');

      if (!response.ok) {
        throw new Error('Failed to fetch location');
      }

      const data = await response.json();
      const city = data.city;

      if (city) {
        setEditLocation(city);
        toast.success(`Location detected: ${city}`);
      } else {
        toast.error("Couldn't determine your city");
      }
    } catch (error) {
      console.error('Location detection error:', error);
      toast.error("Failed to detect location");
    } finally {
      setIsDetectingLocation(false);
    }
  };

  return (
    <SettingsLayout title="Personal">
      <div className="space-y-8 text-left">
        <div className="space-y-3">
          <Label htmlFor="name" className="text-sm text-foreground font-sans">Name</Label>
          <input
            id="name"
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            placeholder="Your name"
            className="input-dotted w-full text-center font-serif text-xl"
          />
        </div>

        <div className="space-y-3">
          <Label htmlFor="location" className="text-sm text-foreground font-sans">Location</Label>
          <div className="flex gap-2 items-end">
            <input
              id="location"
              type="text"
              value={editLocation}
              onChange={(e) => setEditLocation(e.target.value)}
              placeholder="e.g. Cupertino"
              className="input-dotted flex-1 text-center font-serif text-xl"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={handleDetectLocation}
              disabled={isDetectingLocation}
              title="Detect my location"
              className="mb-1"
            >
              {isDetectingLocation ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <MapPin className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        <button
          onClick={handleSave}
          className="w-full inline-flex items-center justify-center gap-3 px-8 py-4 border-2 border-foreground 
                     font-sans text-sm tracking-wider uppercase transition-all duration-200
                     text-foreground hover:bg-foreground hover:text-background"
        >
          Save
        </button>

        {/* Instagram Switch Account */}
        <div className="pt-8 border-t border-border space-y-4">
          <Label className="text-sm text-foreground font-sans">Instagram Account</Label>
          <div className="bg-card p-4 flex items-center justify-between border border-border/50">
            <div className="flex items-center gap-3">
              {isCheckingSession ? (
                <>
                  <div className="w-2 h-2 rounded-full bg-muted-foreground/30 animate-pulse" />
                  <span className="font-sans text-sm text-muted-foreground/50">Checking...</span>
                </>
              ) : (
                <>
                  <div className={`w-2 h-2 rounded-full ${sessionStatus?.isActive ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
                  <span className="font-sans text-sm text-muted-foreground">
                    {sessionStatus?.isActive ? 'Session Active' : 'Session Inactive'}
                  </span>
                </>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                try {
                  await window.api.clearInstagramSession();
                  toast.success("Logged out. Redirecting to login...");
                  navigate("/");
                } catch (e) {
                  toast.error("Failed to switch account");
                }
              }}
              className="text-xs h-8"
            >
              SWITCH ACCOUNT
            </Button>
          </div>
        </div>

      </div>
    </SettingsLayout>
  );
};

export default PersonalSettings;
