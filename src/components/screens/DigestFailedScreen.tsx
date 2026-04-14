import { memo } from "react";
import { motion } from "framer-motion";
import { BrokenWifiMac } from "../icons/PixelIcons";
import { ease, duration, spring } from "@/lib/animations";

interface DigestFailedScreenProps {
  onRetry: () => void;
  message?: string;
}

const contentEntranceTransition = { delay: 0.2, duration: duration.slow, ease: ease.cinematic };
const subtextTransition = { delay: 0.3, duration: duration.slow };
const buttonEntranceTransition = { duration: duration.slow, ease: ease.cinematic, delay: 0.6 };

const DigestFailedScreen = memo(({ onRetry, message }: DigestFailedScreenProps) => {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 bg-background relative">
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ ...spring.gentle, delay: 0.1 }}
        className="mb-8"
      >
        <BrokenWifiMac size={200} />
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={contentEntranceTransition}
        className="text-center max-w-sm space-y-4"
      >
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={subtextTransition}
          className="text-lg text-foreground"
        >
          {message || "Network connection lost"}
        </motion.p>

        <motion.button
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={buttonEntranceTransition}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={onRetry}
          className="inline-flex items-center gap-3 px-8 py-4 border-2 border-foreground
                     text-foreground font-sans text-sm tracking-wider uppercase
                     hover:bg-foreground hover:text-background transition-all duration-200 mt-4"
        >
          Try Again
        </motion.button>
      </motion.div>
    </div>
  );
});

DigestFailedScreen.displayName = "DigestFailedScreen";

export default DigestFailedScreen;
