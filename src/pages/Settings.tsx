import { useCallback, memo } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { PixelKey, PixelUser } from "@/components/icons/PixelIcons";
import { useSettings } from "@/hooks/useSettings";
import { useArchivedAnalyses } from "@/hooks/useArchivedAnalyses";
import { ease, duration, spring, stagger } from "@/lib/animations";

// Animation variants defined outside component
const cardHiddenVisible = {
  hidden: { opacity: 0, y: 15, scale: 0.98 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: spring.gentle,
  }
};

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: stagger.fast,
      delayChildren: 0.15,
    }
  }
};

const Settings = memo(() => {
  const navigate = useNavigate();
  const location = useLocation();
  const fromScreen = (location.state as { from?: string })?.from || "agent";
  const { settings, resetSettings, isLoaded } = useSettings();
  const { clearAnalyses } = useArchivedAnalyses();

  const handleDevReset = useCallback(async () => {
    try {
      await (window as any).api.resetSession();
    } catch (e) {
      console.error("Failed to reset session:", e);
    }
    resetSettings();
    clearAnalyses();
    // Hard reload to ensure all in-memory state is cleared
    window.location.assign("/");
  }, [resetSettings, clearAnalyses]);

  const handleBack = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  const handleCardClick = useCallback((path: string) => {
    navigate(path);
  }, [navigate]);

  if (!isLoaded) {
    return <div className="min-h-screen bg-background" />;
  }

  const getPersonalSummary = () => {
    if (settings.userName && settings.location) {
      return `${settings.userName} · ${settings.location}`;
    }
    if (settings.userName) return settings.userName;
    if (settings.location) return settings.location;
    return "Not set";
  };

  const getApiSummary = () => {
    if (settings.apiKey) {
      return "Key configured";
    }
    return "No API key set";
  };

  const cards = [
    {
      title: "Personal",
      summary: getPersonalSummary(),
      icon: <PixelUser size={40} color="charcoal" />,
      path: "/settings/personal",
    },
    {
      title: "API & Usage",
      summary: getApiSummary(),
      icon: <PixelKey size={40} color="charcoal" />,
      path: "/settings/api",
    },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground py-16 px-6 relative">
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: duration.slow, ease: ease.cinematic }}
        className="absolute top-6 left-6 z-10"
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={handleBack}
          className="text-muted-foreground hover:bg-transparent opacity-60 hover:opacity-100 transition-opacity h-14 w-14"
        >
          <ArrowLeft className="w-6 h-6" />
        </Button>
      </motion.div>

      <div className="max-w-md mx-auto space-y-8 text-center">
        <motion.h1
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: duration.slow, ease: ease.cinematic }}
          className="text-5xl md:text-6xl font-serif text-foreground mb-4 tracking-tight"
        >
          Preferences
        </motion.h1>

        {/* Cards Grid */}
        <motion.div
          className="grid grid-cols-2 gap-4"
          initial="hidden"
          animate="visible"
          variants={containerVariants}
        >
          {cards.map((card, index) => (
            <motion.button
              key={card.title}
              variants={cardHiddenVisible}
              whileHover={{ y: -4, boxShadow: "0 8px 24px rgba(0,0,0,0.1)" }}
              whileTap={{ scale: 0.98 }}
              onClick={() => handleCardClick(card.path)}
              className="aspect-square border-2 p-6 flex flex-col items-center justify-center gap-3
                         transition-colors duration-200 bg-card border-foreground/20 hover:border-foreground cursor-pointer"
            >
              <motion.div
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ ...spring.bouncy, delay: 0.25 + index * stagger.fast }}
              >
                {card.icon}
              </motion.div>
              <span className="font-sans text-foreground text-base">{card.title}</span>
              <span className="font-sans text-muted-foreground text-sm">{card.summary}</span>
            </motion.button>
          ))}
        </motion.div>

        {/* Dev Buttons */}
        <div className="flex flex-col items-center gap-2 mt-8">
          <button
            onClick={handleDevReset}
            className="text-xs text-muted-foreground/50 hover:text-muted-foreground underline"
          >
            Reset Settings & Data
          </button>
        </div>
      </div>

    </div>
  );
});

Settings.displayName = "Settings";

export default Settings;
