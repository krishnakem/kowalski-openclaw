import { useCallback, memo } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { WavingPenguin } from "../icons/PixelIcons";
import { Button } from "@/components/ui/button";
import PageHeader from "@/components/layouts/PageHeader";
import { ease, duration, spring } from "@/lib/animations";
import { useSettings } from "@/hooks/useSettings";
import { getTimeOfDayGreeting } from "@/lib/timeUtils";


interface AnalysisReadyScreenProps {
  onViewAnalysis: () => void;
  lastAnalysisDate?: string;
}

// Animation transitions defined outside component
const contentEntranceTransition = { delay: 0.2, duration: duration.slow, ease: ease.cinematic };
const subtextTransition = { delay: 0.3, duration: duration.slow };
const buttonEntranceTransition = { duration: duration.slow, ease: ease.cinematic, delay: 0.6 };

const AnalysisReadyScreen = memo(({ onViewAnalysis, lastAnalysisDate }: AnalysisReadyScreenProps) => {
  const navigate = useNavigate();
  const { settings } = useSettings();


  const greeting = getTimeOfDayGreeting();

  const title = settings.userName?.trim()
    ? `${greeting}, ${settings.userName.trim()}`
    : greeting;

  const leftAction = null;

  const rightAction = null;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 bg-background relative">
      <PageHeader
        title=""
        leftAction={leftAction}
        rightAction={rightAction}
      />

      {/* Penguin */}
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ ...spring.gentle, delay: 0.1 }}
        className="mb-8"
      >
        <WavingPenguin size={160} />
      </motion.div>

      {/* Content */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={contentEntranceTransition}
        className="text-center max-w-sm space-y-4"
      >
        <h1 className="text-4xl font-serif text-foreground">
          {title}
        </h1>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={subtextTransition}
          className="text-lg text-muted-foreground"
        >
          Your analysis is ready
        </motion.p>


        <motion.button
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={buttonEntranceTransition}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={onViewAnalysis}
          className="inline-flex items-center gap-3 px-8 py-4 border-2 border-foreground 
                     text-foreground font-sans text-sm tracking-wider uppercase
                     hover:bg-foreground hover:text-background transition-all duration-200 mt-4"
        >
          View Analysis
        </motion.button>
      </motion.div>
    </div>
  );
});

AnalysisReadyScreen.displayName = "AnalysisReadyScreen";

export default AnalysisReadyScreen;
