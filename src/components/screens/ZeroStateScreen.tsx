import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence, useMotionValue, useSpring, useTransform } from "framer-motion";
import { Eye, EyeOff, Instagram, Loader2 } from "lucide-react";
import { WavingPenguin } from "../icons/PixelIcons";
import { useSettings } from "@/hooks/useSettings";

interface ZeroStateScreenProps {
  onContinue: () => void;
}

type Step = "hook" | "name" | "key" | "instagram";

const TypewriterText = ({
  text,
  onComplete,
  speed = 90
}: {
  text: string;
  onComplete: () => void;
  speed?: number;
}) => {
  const [displayedText, setDisplayedText] = useState("");
  const [isComplete, setIsComplete] = useState(false);
  const hasStarted = useRef(false);

  useEffect(() => {
    if (hasStarted.current) return;
    hasStarted.current = true;

    let index = 0;

    const typeNext = () => {
      if (index < text.length) {
        setDisplayedText(text.slice(0, index + 1));
        const char = text[index];
        index++;

        // Variable delay for natural feel
        let delay = speed + Math.random() * 30; // Base + slight randomness
        if (char === '.' || char === ',' || char === '!') delay += 150; // Pause after punctuation
        if (char === ' ') delay -= 10; // Faster for spaces

        setTimeout(typeNext, delay);
      } else {
        setIsComplete(true);
        onComplete();
      }
    };

    typeNext();
  }, [text, speed, onComplete]);

  return (
    <span className="font-serif text-foreground">
      {displayedText}
      <motion.span
        animate={{ opacity: isComplete ? 0 : [1, 0] }}
        transition={isComplete
          ? { duration: 0.3 }
          : { duration: 0.5, repeat: Infinity, repeatType: "reverse" }
        }
        className="inline-block w-[3px] h-10 md:h-12 bg-foreground ml-1 align-middle"
      />
    </span>
  );
};

const ZeroStateScreen = ({ onContinue }: ZeroStateScreenProps) => {
  const { settings, patchSettings, isLoaded } = useSettings();
  const [step, setStep] = useState<Step>("hook");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [firstLineComplete, setFirstLineComplete] = useState(false);
  const [typingComplete, setTypingComplete] = useState(false);
  const [showBegin, setShowBegin] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [userName, setUserName] = useState("");
  const [nameQuestionComplete, setNameQuestionComplete] = useState(false);

  // Hydrate from settings once loaded
  useEffect(() => {
    if (isLoaded) {
      if (settings.userName) setUserName(settings.userName);
      if (settings.apiKey) setApiKey(settings.apiKey);
    }
  }, [isLoaded, settings]);

  useEffect(() => {
    if (!typingComplete) {
      setShowBegin(false);
      return;
    }

    const t = window.setTimeout(() => setShowBegin(true), 600);
    return () => window.clearTimeout(t);
  }, [typingComplete]);

  // Enter-to-advance for the button-only steps (hook + instagram). The name
  // and key steps handle Enter on their own inputs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (step === "hook" && showBegin) {
        e.preventDefault();
        handleBegin();
      } else if (step === "instagram") {
        e.preventDefault();
        handleConnectClick();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, showBegin]);

  // Smooth penguin animation using springs
  const mouseX = useMotionValue(0);
  const smoothX = useSpring(mouseX, { stiffness: 100, damping: 20, mass: 0.5 });
  const penguinX = useTransform(smoothX, (v) => v * 12);
  const penguinRotate = useTransform(smoothX, (v) => v * 8);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      // Calculate offset from center of screen, normalized to -1 to 1
      const x = (e.clientX / window.innerWidth - 0.5) * 2;
      mouseX.set(x);
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [mouseX]);

  const handleBegin = () => {
    setStep("name");
  };

  const handleNameContinue = () => {
    patchSettings({ userName: userName.trim() });
    setStep("key");
  };

  const handleInitialize = async () => {
    if (!apiKey) return;

    setIsValidating(true);
    setKeyError(null);

    try {
      const result = await window.api.settings.validateApiKey(apiKey);
      if (!result.valid) {
        setKeyError('Invalid API key. Please check and try again.');
        return;
      }

      // Valid key - save and proceed
      patchSettings({ apiKey });
      setStep("instagram");
    } catch (error) {
      setKeyError('Could not validate key. Check your connection.');
    } finally {
      setIsValidating(false);
    }
  };

  // "Connect Account" triggers onContinue, which marks the user as onboarded
  // and transitions to the screencast-based login screen.
  const handleConnectClick = () => {
    onContinue();
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 bg-background relative">
      {/* Waving Penguin in bottom left - on all steps */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.3 }}
        style={{ x: penguinX, rotate: penguinRotate }}
        className="fixed bottom-8 left-8"
      >
        <WavingPenguin size={80} />
      </motion.div>
      <AnimatePresence mode="wait">
        {/* Step 1: The Hook */}
        {step === "hook" && (
          <motion.div
            key="hook"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className="max-w-lg w-full text-center space-y-12"
          >
            <div className="text-5xl leading-relaxed space-y-2">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.5, delay: 0.2 }}
              >
                <TypewriterText
                  text="Kowalski doomscrolls."
                  onComplete={() => setFirstLineComplete(true)}
                />
              </motion.div>
              {firstLineComplete && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.5 }}
                >
                  <TypewriterText
                    text="So you don't have to."
                    onComplete={() => setTypingComplete(true)}
                  />
                </motion.div>
              )}
            </div>

            <div className="flex justify-center min-h-[56px]">
              <motion.button
                initial={false}
                animate={{ opacity: showBegin ? 1 : 0 }}
                transition={{ duration: 0.5, ease: "easeOut" }}
                onClick={handleBegin}
                tabIndex={showBegin ? 0 : -1}
                aria-hidden={!showBegin}
                className={
                  "px-8 py-4 border-2 border-foreground " +
                  "text-foreground font-sans text-sm tracking-wider uppercase " +
                  "hover:bg-foreground hover:text-background transition-all duration-200" +
                  (showBegin ? "" : " pointer-events-none")
                }
              >
                Begin
              </motion.button>
            </div>
          </motion.div>
        )}

        {/* Step 2: Name */}
        {step === "name" && (
          <motion.div
            key="name"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className="max-w-2xl w-full text-center flex flex-col items-center"
          >
            {/* Typewriter question - fixed position */}
            <div className="text-4xl md:text-5xl leading-relaxed mb-8">
              <TypewriterText
                text="What's your name?"
                onComplete={() => setNameQuestionComplete(true)}
                speed={80}
              />
            </div>

            {/* Input section - reserved space to prevent layout shift */}
            <div className="h-16 flex items-center justify-center mb-8">
              <AnimatePresence>
                {nameQuestionComplete && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.3, delay: 0.2 }}
                    className="inline-flex items-center justify-center"
                  >
                    <input
                      type="text"
                      value={userName}
                      onChange={(e) => setUserName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleNameContinue()}
                      placeholder=""
                      autoFocus
                      className="bg-transparent border-none outline-none
                                 font-serif text-4xl md:text-5xl text-foreground
                                 text-center caret-transparent"
                      style={{ width: `${Math.max(2, userName.length + 1)}ch` }}
                    />
                    {/* Blinking cursor - matches TypewriterText cursor */}
                    <motion.span
                      animate={{ opacity: [1, 0] }}
                      transition={{ duration: 0.5, repeat: Infinity, repeatType: "reverse" }}
                      className="inline-block w-[3px] h-10 md:h-12 bg-foreground ml-1 align-middle"
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Button section - reserved space */}
            <div className="h-16 flex items-center justify-center">
              <AnimatePresence mode="wait">
                {nameQuestionComplete && userName.trim() && (
                  <motion.button
                    key="continue-btn"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.3 }}
                    onClick={handleNameContinue}
                    className="px-8 py-4 border-2 border-foreground
                               text-foreground font-sans text-sm tracking-wider uppercase
                               hover:bg-foreground hover:text-background transition-all duration-200"
                  >
                    Continue
                  </motion.button>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}

        {/* Step 3: The Key */}
        {step === "key" && (
          <motion.div
            key="key"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className="max-w-md w-full space-y-12 relative"
          >
            {/* Headline */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              className="text-center space-y-4"
            >
              <h2 className="text-5xl font-serif text-foreground">
                {userName.trim() ? `${userName.trim()}, what` : "What"} is your Anthropic API Key?
              </h2>
              <p className="text-muted-foreground text-sm font-sans leading-relaxed max-w-sm mx-auto">
                Kowalski is private by design. Your data is processed using your personal Anthropic API key and stored locally on your device.
              </p>
            </motion.div>

            {/* API Key Input */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.25, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              className="space-y-2"
            >
              <div className="relative">
                <input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setKeyError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && apiKey && !isValidating) handleInitialize();
                  }}
                  placeholder="sk-ant-..."
                  className={`w-full input-dotted text-foreground placeholder:text-foreground/30
                             font-sans text-lg tracking-wider pr-12 py-4 ${keyError ? 'border-destructive' : ''}`}
                />
                <button
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-0 top-1/2 -translate-y-1/2 p-3 text-muted-foreground transition-colors"
                >
                  {showKey ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
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
            </motion.div>

            {/* Next Button */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3, duration: 0.5 }}
              className="flex justify-center"
            >
              <button
                onClick={handleInitialize}
                disabled={!apiKey || isValidating}
                className={`inline-flex items-center gap-3 px-8 py-4 border-2 font-sans text-sm tracking-wider uppercase transition-all duration-200
                           ${apiKey && !isValidating
                    ? "border-foreground text-foreground hover:bg-foreground hover:text-background cursor-pointer"
                    : "border-foreground/20 text-foreground/30 cursor-not-allowed"
                  }`}
              >
                {isValidating ? (
                  <>
                    <Loader2 size={16} className="animate-spin text-foreground" />
                    <span className="text-foreground">Validating...</span>
                  </>
                ) : (
                  "Next"
                )}
              </button>
            </motion.div>
          </motion.div>
        )}

        {/* Step 4: Instagram Connect */}
        {step === "instagram" && (
          <motion.div
            key="instagram"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className="max-w-sm w-full"
          >
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              className="bg-background rounded-3xl p-12 flex flex-col items-center gap-12"
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.3, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              >
                <Instagram className="w-16 h-16 text-foreground" strokeWidth={1.5} />
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.4, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                className="text-center space-y-4"
              >
                <h2 className="text-4xl md:text-5xl font-serif text-foreground leading-tight">
                  Last step{userName.trim() ? ` ${userName.trim()}` : ""},<br />
                  <span className="whitespace-nowrap">Connect your Instagram.</span>
                </h2>
                <p className="text-muted-foreground text-sm font-sans">
                  Kowalski interacts with Instagram in a local sandbox. Your credentials never leave your device.
                </p>
              </motion.div>

              <motion.button
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                onClick={handleConnectClick}
                className="px-8 py-4 border-2 border-foreground
                           text-foreground font-sans text-sm tracking-wider uppercase
                           hover:bg-foreground hover:text-background transition-all duration-200"
              >
                Connect Account
              </motion.button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default ZeroStateScreen;
