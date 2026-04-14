import { useEffect, useCallback, memo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Settings, Archive, Search, Square, SkipForward } from "lucide-react";
import { AnimatedPixelPenguin } from "../icons/PixelIcons";
import { LiveScreencast } from "../LiveScreencast";
import { Button } from "@/components/ui/button";
import { useSettings } from "@/hooks/useSettings";
import { useArchivedAnalyses } from "@/hooks/useArchivedAnalyses";
import { ease, duration, spring } from "@/lib/animations";
import { KOWALSKI_VIEWPORT } from "@/shared/viewportConfig";

interface AgentActiveScreenProps {
  onComplete: () => void;
  autoComplete?: boolean;
}

type RunState = "idle" | "running" | "generatingDigest";
type RunPhase = "stories" | "feed" | null;

// Animation transitions defined outside component
const buttonEntranceTransition = { delay: 0.4, duration: duration.slow, ease: ease.cinematic };
const contentEntranceTransition = { delay: 0.25, duration: duration.slow, ease: ease.cinematic };

const formatCountdown = (ms: number): string => {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const AgentActiveScreen = memo(({ onComplete, autoComplete = true }: AgentActiveScreenProps) => {
  const navigate = useNavigate();
  const { settings } = useSettings();
  const { hasPastAnalyses, isLoaded: archivesLoaded } = useArchivedAnalyses();

  const [runState, setRunState] = useState<RunState>("idle");
  const [runPhase, setRunPhase] = useState<RunPhase>(null);
  const [feedDeadline, setFeedDeadline] = useState<number | null>(null);
  const [nowTs, setNowTs] = useState<number>(Date.now());
  const [firstFrameReceived, setFirstFrameReceived] = useState(false);

  // Check initial run status on mount
  useEffect(() => {
    window.api.run.getStatus().then((status) => {
      if (status === 'running') {
        setRunState('running');
      }
    });
  }, []);

  // Listen for run lifecycle events
  useEffect(() => {
    const unsubStart = window.api.settings.onRunStarted(() => {
      setFirstFrameReceived(false);
      setRunPhase(null);
      setFeedDeadline(null);
      setRunState("running");
    });

    const unsubPhase = window.api.settings.onRunPhase(({ phase, maxDurationMs }) => {
      setRunPhase(phase);
      if (phase === "feed" && typeof maxDurationMs === "number") {
        setFeedDeadline(Date.now() + maxDurationMs);
      } else {
        setFeedDeadline(null);
      }
    });

    const unsubScreencastEnded = window.api.screencast.onEnded(() => {
      setRunState((prev) => prev === "running" ? "generatingDigest" : prev);
    });

    const unsubComplete = window.api.settings.onRunComplete(() => {
      setRunState("idle");
      setRunPhase(null);
      setFeedDeadline(null);
    });

    return () => {
      unsubStart();
      unsubPhase();
      unsubScreencastEnded();
      unsubComplete();
    };
  }, []);

  // Tick every 250ms while the feed countdown is active
  useEffect(() => {
    if (feedDeadline === null) return;
    const id = setInterval(() => setNowTs(Date.now()), 250);
    return () => clearInterval(id);
  }, [feedDeadline]);

  // Navigate to Gazette when analysis is ready
  useEffect(() => {
    if (settings.analysisStatus === 'ready') {
      onComplete();
    }
  }, [settings.analysisStatus, onComplete]);

  const showArchiveButton = archivesLoaded && hasPastAnalyses;

  const handleRunNow = useCallback(async () => {
    setFirstFrameReceived(false);
    setRunState("running");
    await window.api.run.start();
  }, []);

  const handleStop = useCallback(async () => {
    await window.api.run.stop();
  }, []);

  const handleSkipToFeed = useCallback(async () => {
    await window.api.run.skipToFeed();
  }, []);

  const handleNavigateToArchive = useCallback(() => {
    navigate("/archive", { state: { from: "agent" } });
  }, [navigate]);

  const handleNavigateToSettings = useCallback(() => {
    navigate("/settings", { state: { from: "agent" } });
  }, [navigate]);

  // --- Running: screencast fills the entire window, STOP + indicator overlay bottom-right ---
  if (runState === "running") {
    return (
      <>
        {/* Screencast layer — no position/overflow so it can't trap clicks */}
        <div style={{ width: KOWALSKI_VIEWPORT.width, height: KOWALSKI_VIEWPORT.height }}>
          <LiveScreencast onFirstFrame={() => setFirstFrameReceived(true)} />
        </div>

        {/* "Starting session..." overlay — covers the area until the first frame */}
        {!firstFrameReceived && (
          <div
            className="flex flex-col items-center justify-center bg-background"
            style={{ position: 'fixed', inset: 0 }}
          >
            <AnimatedPixelPenguin size={200} />
            <p className="mt-8 text-foreground font-sans text-lg leading-relaxed animate-pulse">
              Starting session...
            </p>
          </div>
        )}

        {/* Floating overlay: a single pill with two sections — the "Run in progress"
            indicator (non-interactive) and the Stop button (always visible, clickable).
            position:fixed keeps it outside any stacking context so clicks always reach it. */}
        {firstFrameReceived && (
          <div style={{
            position: 'fixed', bottom: 16, right: 16, zIndex: 9999,
            display: 'inline-flex', alignItems: 'stretch',
            borderRadius: 6, overflow: 'hidden',
            background: 'rgba(255,255,255,0.92)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            border: '1.5px solid rgba(0,0,0,0.15)',
            fontSize: 11, fontWeight: 500, color: '#111',
            letterSpacing: '0.08em', textTransform: 'uppercase' as const,
            fontFamily: "'Inter', system-ui, sans-serif",
          }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '6px 10px',
            }}>
              <span className="run-indicator-dot" style={{
                width: 8, height: 8, borderRadius: '50%',
                background: '#ef4444', flexShrink: 0,
              }} />
              <span className="run-indicator-text">Run in progress</span>
            </div>
            {runPhase === "stories" && (
              <button
                onClick={handleSkipToFeed}
                className="run-stop-button"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px',
                  borderLeft: '1.5px solid rgba(0,0,0,0.15)',
                  background: 'transparent', cursor: 'pointer',
                  font: 'inherit', color: 'inherit',
                  letterSpacing: 'inherit', textTransform: 'inherit' as const,
                }}
              >
                <SkipForward style={{ width: 10, height: 10 }} />
                Skip to Feed
              </button>
            )}
            {runPhase === "feed" && feedDeadline !== null && (
              <div
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px',
                  borderLeft: '1.5px solid rgba(0,0,0,0.15)',
                  font: 'inherit', color: 'inherit',
                  letterSpacing: 'inherit', textTransform: 'inherit' as const,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                Feed {formatCountdown(Math.max(0, feedDeadline - nowTs))}
              </div>
            )}
            <button
              onClick={handleStop}
              className="run-stop-button"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '6px 12px',
                borderLeft: '1.5px solid rgba(0,0,0,0.15)',
                background: 'transparent', cursor: 'pointer',
                font: 'inherit', color: 'inherit',
                letterSpacing: 'inherit', textTransform: 'inherit' as const,
              }}
            >
              <Square style={{ width: 10, height: 10 }} />
              Stop
            </button>
          </div>
        )}

        {/* Keyframe animations for the indicator + Stop hover state */}
        <style>{`
          @keyframes indicatorPulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
          }
          .run-indicator-dot,
          .run-indicator-text {
            animation: indicatorPulse 1.2s ease-in-out infinite;
          }
          .run-stop-button:hover { background: rgba(0,0,0,0.06); }
          @media (prefers-reduced-motion: reduce) {
            .run-indicator-dot, .run-indicator-text {
              animation: none;
              opacity: 1;
            }
          }
        `}</style>
      </>
    );
  }

  // --- Generating digest interstitial ---
  if (runState === "generatingDigest") {
    return (
      <div
        className="flex flex-col items-center justify-center bg-background"
        style={{ width: KOWALSKI_VIEWPORT.width, height: KOWALSKI_VIEWPORT.height }}
      >
        <AnimatedPixelPenguin size={200} />
        <p className="mt-8 text-foreground font-sans text-lg leading-relaxed animate-pulse">
          Generating digest...
        </p>
      </div>
    );
  }

  // --- Idle: centered penguin + buttons ---
  return (
    <div className="flex flex-col items-center justify-center px-6 bg-background relative overflow-auto"
         style={{ width: KOWALSKI_VIEWPORT.width, height: KOWALSKI_VIEWPORT.height }}>

      {showArchiveButton && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={buttonEntranceTransition}
          className="absolute top-6 left-6"
        >
          <Button
            variant="ghost"
            size="icon"
            onClick={handleNavigateToArchive}
            className="text-muted-foreground hover:bg-transparent opacity-60 hover:opacity-100 transition-opacity h-14 w-14"
          >
            <Archive className="w-8 h-8" />
          </Button>
        </motion.div>
      )}

      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={buttonEntranceTransition}
        className="absolute top-6 right-6"
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={handleNavigateToSettings}
          className="text-muted-foreground hover:bg-transparent opacity-60 hover:opacity-100 transition-opacity h-14 w-14"
        >
          <Settings className="w-8 h-8" />
        </Button>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ ...spring.gentle, delay: 0.1 }}
        className="mb-12"
      >
        <AnimatedPixelPenguin size={200} />
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={contentEntranceTransition}
        className="text-center max-w-sm space-y-6"
      >
        <button
          onClick={handleRunNow}
          className="inline-flex items-center gap-3 px-8 py-4 border-2 border-foreground
                     text-foreground font-sans text-sm tracking-wider uppercase
                     hover:bg-foreground hover:text-background transition-all duration-200"
        >
          <Search className="w-4 h-4" />
          <span>Start Digest Run</span>
        </button>
      </motion.div>
    </div>
  );
});

AgentActiveScreen.displayName = "AgentActiveScreen";

export default AgentActiveScreen;
