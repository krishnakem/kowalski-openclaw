import { useEffect, useState, memo } from "react";
import { AnimatedPixelPenguin } from "../icons/PixelIcons";
import { LiveScreencast } from "../LiveScreencast";
import { KOWALSKI_VIEWPORT } from "@/shared/viewportConfig";

interface LoginScreenProps {
  onLoginSuccess: () => void;
}

/**
 * Headless-login screen: shows the Instagram login page via CDP screencast
 * inside the Kowalski window. The user clicks/types on the canvas and their
 * input is forwarded to the headless browser. No footer — the screencast
 * fills the entire 1280×900 window.
 */
const LoginScreen = memo(({ onLoginSuccess }: LoginScreenProps) => {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    window.api.login.startScreencast();

    const unsubReady = window.api.login.onReady(() => setReady(true));
    const unsubSuccess = window.api.login.onSuccess(() => onLoginSuccess());

    return () => {
      unsubReady();
      unsubSuccess();
      window.api.login.stopScreencast();
    };
  }, [onLoginSuccess]);

  return (
    <div style={{ width: KOWALSKI_VIEWPORT.width, height: KOWALSKI_VIEWPORT.height, overflow: 'hidden', position: 'relative' }}>
      <LiveScreencast
        interactive
        onFirstFrame={() => setReady(true)}
      />

      {/* Loading interstitial — shown until first frame */}
      {!ready && (
        <div
          className="flex flex-col items-center justify-center bg-background"
          style={{ position: 'absolute', inset: 0 }}
        >
          <AnimatedPixelPenguin size={200} />
          <p className="mt-8 text-foreground font-sans text-lg leading-relaxed animate-pulse">
            Loading Instagram...
          </p>
        </div>
      )}
    </div>
  );
});

LoginScreen.displayName = "LoginScreen";

export default LoginScreen;
