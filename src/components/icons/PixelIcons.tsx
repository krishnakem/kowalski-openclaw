import { memo } from "react";
import { motion } from "framer-motion";

interface PixelIconProps {
  className?: string;
  size?: number;
  color?: "charcoal" | "blue" | "orange" | "yellow";
}

// 24x24 pixel grid icons rendered as SVG
const getColor = (color: "charcoal" | "blue" | "orange" | "yellow" = "charcoal") => {
  switch (color) {
    case "blue": return "#5A72A0";
    case "orange": return "#D4854A";
    case "yellow": return "#C9B463";
    default: return "#1C1C1E";
  }
};

export const PixelSun = memo(({ className, size = 24, color = "charcoal" }: PixelIconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ imageRendering: "pixelated" }}>
    <rect x="11" y="2" width="2" height="3" fill={getColor(color)} />
    <rect x="11" y="19" width="2" height="3" fill={getColor(color)} />
    <rect x="2" y="11" width="3" height="2" fill={getColor(color)} />
    <rect x="19" y="11" width="3" height="2" fill={getColor(color)} />
    <rect x="4" y="4" width="2" height="2" fill={getColor(color)} />
    <rect x="18" y="4" width="2" height="2" fill={getColor(color)} />
    <rect x="4" y="18" width="2" height="2" fill={getColor(color)} />
    <rect x="18" y="18" width="2" height="2" fill={getColor(color)} />
    <rect x="9" y="7" width="6" height="2" fill={getColor(color)} />
    <rect x="7" y="9" width="2" height="6" fill={getColor(color)} />
    <rect x="15" y="9" width="2" height="6" fill={getColor(color)} />
    <rect x="9" y="15" width="6" height="2" fill={getColor(color)} />
    <rect x="9" y="9" width="6" height="6" fill={getColor(color)} opacity="0.3" />
  </svg>
));
PixelSun.displayName = "PixelSun";

export const PixelMoon = memo(({ className, size = 24, color = "charcoal" }: PixelIconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ imageRendering: "pixelated" }}>
    <rect x="10" y="3" width="6" height="2" fill={getColor(color)} />
    <rect x="8" y="5" width="2" height="2" fill={getColor(color)} />
    <rect x="6" y="7" width="2" height="4" fill={getColor(color)} />
    <rect x="6" y="13" width="2" height="4" fill={getColor(color)} />
    <rect x="8" y="17" width="2" height="2" fill={getColor(color)} />
    <rect x="10" y="19" width="6" height="2" fill={getColor(color)} />
    <rect x="16" y="5" width="2" height="2" fill={getColor(color)} />
    <rect x="16" y="17" width="2" height="2" fill={getColor(color)} />
    <rect x="14" y="7" width="2" height="2" fill={getColor(color)} />
    <rect x="12" y="9" width="2" height="2" fill={getColor(color)} />
    <rect x="12" y="13" width="2" height="2" fill={getColor(color)} />
    <rect x="14" y="15" width="2" height="2" fill={getColor(color)} />
  </svg>
));
PixelMoon.displayName = "PixelMoon";

export const PixelInstagram = memo(({ className, size = 24, color = "charcoal" }: PixelIconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ imageRendering: "pixelated" }}>
    <rect x="4" y="4" width="16" height="16" fill={getColor(color)} />
    <rect x="6" y="6" width="12" height="12" fill="#F9F8F5" />
    <rect x="9" y="9" width="6" height="6" fill={getColor(color)} />
    <rect x="10" y="10" width="4" height="4" fill="#F9F8F5" />
    <rect x="11" y="11" width="2" height="2" fill={getColor(color)} />
    <rect x="16" y="6" width="2" height="2" fill={getColor(color)} />
  </svg>
));
PixelInstagram.displayName = "PixelInstagram";

export const PixelFloppy = memo(({ className, size = 24, color = "charcoal" }: PixelIconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ imageRendering: "pixelated" }}>
    <rect x="4" y="3" width="16" height="18" fill={getColor(color)} />
    <rect x="6" y="3" width="10" height="6" fill="#F9F8F5" />
    <rect x="12" y="4" width="2" height="4" fill={getColor(color)} />
    <rect x="6" y="13" width="12" height="6" fill="#F9F8F5" />
    <rect x="8" y="15" width="8" height="1" fill={getColor(color)} opacity="0.3" />
    <rect x="8" y="17" width="6" height="1" fill={getColor(color)} opacity="0.3" />
  </svg>
));
PixelFloppy.displayName = "PixelFloppy";

export const PixelEye = memo(({ className, size = 24, color = "charcoal" }: PixelIconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ imageRendering: "pixelated" }}>
    <rect x="6" y="8" width="12" height="2" fill={getColor(color)} />
    <rect x="4" y="10" width="2" height="4" fill={getColor(color)} />
    <rect x="18" y="10" width="2" height="4" fill={getColor(color)} />
    <rect x="6" y="14" width="12" height="2" fill={getColor(color)} />
    <rect x="6" y="10" width="12" height="4" fill={getColor(color)} opacity="0.2" />
    <rect x="10" y="10" width="4" height="4" fill={getColor(color)} />
    <rect x="11" y="11" width="2" height="2" fill="#F9F8F5" />
  </svg>
));
PixelEye.displayName = "PixelEye";

export const PixelHourglass = memo(({ className, size = 24, color = "charcoal" }: PixelIconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ imageRendering: "pixelated" }}>
    <rect x="6" y="3" width="12" height="2" fill={getColor(color)} />
    <rect x="6" y="19" width="12" height="2" fill={getColor(color)} />
    <rect x="8" y="5" width="8" height="2" fill={getColor(color)} />
    <rect x="10" y="7" width="4" height="2" fill={getColor(color)} />
    <rect x="11" y="9" width="2" height="2" fill={getColor(color)} />
    <rect x="11" y="13" width="2" height="2" fill={getColor(color)} />
    <rect x="10" y="15" width="4" height="2" fill={getColor(color)} />
    <rect x="8" y="17" width="8" height="2" fill={getColor(color)} />
    <rect x="10" y="5" width="4" height="1" fill={getColor(color)} opacity="0.4" />
    <rect x="10" y="17" width="4" height="1" fill={getColor(color)} opacity="0.4" />
  </svg>
));
PixelHourglass.displayName = "PixelHourglass";

export const PixelArrow = memo(({ className, size = 24, color = "charcoal" }: PixelIconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ imageRendering: "pixelated" }}>
    <rect x="4" y="11" width="12" height="2" fill={getColor(color)} />
    <rect x="14" y="9" width="2" height="2" fill={getColor(color)} />
    <rect x="16" y="7" width="2" height="2" fill={getColor(color)} />
    <rect x="14" y="13" width="2" height="2" fill={getColor(color)} />
    <rect x="16" y="15" width="2" height="2" fill={getColor(color)} />
    <rect x="18" y="11" width="2" height="2" fill={getColor(color)} />
  </svg>
));
PixelArrow.displayName = "PixelArrow";

export const PixelCheck = memo(({ className, size = 24, color = "charcoal" }: PixelIconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ imageRendering: "pixelated" }}>
    <rect x="6" y="12" width="2" height="2" fill={getColor(color)} />
    <rect x="8" y="14" width="2" height="2" fill={getColor(color)} />
    <rect x="10" y="16" width="2" height="2" fill={getColor(color)} />
    <rect x="12" y="14" width="2" height="2" fill={getColor(color)} />
    <rect x="14" y="12" width="2" height="2" fill={getColor(color)} />
    <rect x="16" y="10" width="2" height="2" fill={getColor(color)} />
    <rect x="18" y="8" width="2" height="2" fill={getColor(color)} />
  </svg>
));
PixelCheck.displayName = "PixelCheck";

export const PixelPin = memo(({ className, size = 24, color = "charcoal" }: PixelIconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ imageRendering: "pixelated" }}>
    <rect x="10" y="4" width="4" height="2" fill={getColor(color)} />
    <rect x="8" y="6" width="8" height="2" fill={getColor(color)} />
    <rect x="8" y="8" width="8" height="4" fill={getColor(color)} />
    <rect x="10" y="12" width="4" height="2" fill={getColor(color)} />
    <rect x="11" y="14" width="2" height="6" fill={getColor(color)} />
    <rect x="9" y="7" width="2" height="2" fill="#F9F8F5" opacity="0.5" />
  </svg>
));
PixelPin.displayName = "PixelPin";

export const PixelClose = memo(({ className, size = 24, color = "charcoal" }: PixelIconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ imageRendering: "pixelated" }}>
    <rect x="6" y="6" width="2" height="2" fill={getColor(color)} />
    <rect x="8" y="8" width="2" height="2" fill={getColor(color)} />
    <rect x="10" y="10" width="4" height="4" fill={getColor(color)} />
    <rect x="14" y="8" width="2" height="2" fill={getColor(color)} />
    <rect x="16" y="6" width="2" height="2" fill={getColor(color)} />
    <rect x="6" y="16" width="2" height="2" fill={getColor(color)} />
    <rect x="8" y="14" width="2" height="2" fill={getColor(color)} />
    <rect x="14" y="14" width="2" height="2" fill={getColor(color)} />
    <rect x="16" y="16" width="2" height="2" fill={getColor(color)} />
  </svg>
));
PixelClose.displayName = "PixelClose";

export const PixelKey = memo(({ className, size = 24, color = "charcoal" }: PixelIconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ imageRendering: "pixelated" }}>
    <rect x="5" y="6" width="6" height="2" fill={getColor(color)} />
    <rect x="3" y="8" width="2" height="4" fill={getColor(color)} />
    <rect x="11" y="8" width="2" height="4" fill={getColor(color)} />
    <rect x="5" y="12" width="6" height="2" fill={getColor(color)} />
    <rect x="6" y="9" width="4" height="2" fill={getColor(color)} opacity="0.3" />
    <rect x="13" y="10" width="6" height="2" fill={getColor(color)} />
    <rect x="17" y="12" width="2" height="2" fill={getColor(color)} />
    <rect x="19" y="10" width="2" height="2" fill={getColor(color)} />
    <rect x="21" y="12" width="2" height="2" fill={getColor(color)} />
  </svg>
));
PixelKey.displayName = "PixelKey";

export const PixelLightbulb = memo(({ className, size = 24, color = "charcoal" }: PixelIconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ imageRendering: "pixelated" }}>
    <rect x="9" y="3" width="6" height="2" fill={getColor(color)} />
    <rect x="7" y="5" width="2" height="2" fill={getColor(color)} />
    <rect x="15" y="5" width="2" height="2" fill={getColor(color)} />
    <rect x="5" y="7" width="2" height="4" fill={getColor(color)} />
    <rect x="17" y="7" width="2" height="4" fill={getColor(color)} />
    <rect x="9" y="5" width="6" height="6" fill={getColor(color)} opacity="0.2" />
    <rect x="7" y="11" width="2" height="2" fill={getColor(color)} />
    <rect x="15" y="11" width="2" height="2" fill={getColor(color)} />
    <rect x="9" y="13" width="6" height="2" fill={getColor(color)} />
    <rect x="9" y="15" width="6" height="2" fill={getColor(color)} />
    <rect x="10" y="17" width="4" height="2" fill={getColor(color)} />
    <rect x="11" y="19" width="2" height="2" fill={getColor(color)} />
    <rect x="3" y="8" width="2" height="2" fill={getColor(color)} opacity="0.4" />
    <rect x="19" y="8" width="2" height="2" fill={getColor(color)} opacity="0.4" />
  </svg>
));
PixelLightbulb.displayName = "PixelLightbulb";

export const PixelUser = memo(({ className, size = 24, color = "charcoal" }: PixelIconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ imageRendering: "pixelated" }}>
    <rect x="9" y="3" width="6" height="2" fill={getColor(color)} />
    <rect x="7" y="5" width="2" height="4" fill={getColor(color)} />
    <rect x="15" y="5" width="2" height="4" fill={getColor(color)} />
    <rect x="9" y="9" width="6" height="2" fill={getColor(color)} />
    <rect x="9" y="5" width="6" height="4" fill={getColor(color)} opacity="0.2" />
    <rect x="11" y="11" width="2" height="2" fill={getColor(color)} />
    <rect x="5" y="13" width="14" height="2" fill={getColor(color)} />
    <rect x="3" y="15" width="4" height="6" fill={getColor(color)} />
    <rect x="17" y="15" width="4" height="6" fill={getColor(color)} />
    <rect x="7" y="15" width="10" height="6" fill={getColor(color)} />
    <rect x="7" y="17" width="10" height="2" fill={getColor(color)} opacity="0.3" />
  </svg>
));
PixelUser.displayName = "PixelUser";

// Animation variants defined outside component for performance
const eyeFloatAnimation = {
  y: [0, -4, 0],
};

const eyeFloatTransition = {
  duration: 2,
  repeat: Infinity,
  ease: "easeInOut" as const,
};

const pupilAnimation = {
  x: [-1, 1, -1],
};

const pupilTransition = {
  duration: 3,
  repeat: Infinity,
  ease: "easeInOut" as const,
};

// Animated Eye component for Agent screen
export const AnimatedPixelEye = memo(({ className, size = 64 }: PixelIconProps) => (
  <motion.div
    animate={eyeFloatAnimation}
    transition={eyeFloatTransition}
    className={className}
  >
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ imageRendering: "pixelated" }}>
      <rect x="4" y="8" width="16" height="2" fill="#1C1C1E" />
      <rect x="2" y="10" width="2" height="4" fill="#1C1C1E" />
      <rect x="20" y="10" width="2" height="4" fill="#1C1C1E" />
      <rect x="4" y="14" width="16" height="2" fill="#1C1C1E" />
      <rect x="4" y="10" width="16" height="4" fill="#1C1C1E" opacity="0.15" />
      <motion.g
        animate={pupilAnimation}
        transition={pupilTransition}
      >
        <rect x="10" y="10" width="4" height="4" fill="#1C1C1E" />
        <rect x="11" y="11" width="2" height="2" fill="#F9F8F5" />
      </motion.g>
    </svg>
  </motion.div>
));
AnimatedPixelEye.displayName = "AnimatedPixelEye";

// Flipper animation variants
const flipperAnimation = {
  rotate: [-12, 12, -12],
};

const flipperTransition = {
  duration: 1.2,
  repeat: Infinity,
  ease: "easeInOut" as const,
};

// Retro Macintosh with animated penguin on screen
export const AnimatedPixelPenguin = memo(({ className, size = 160 }: { className?: string; size?: number }) => (
  <div className={className}>
    <svg width={size} height={size} viewBox="0 0 48 48" style={{ imageRendering: "pixelated" }}>
      <rect x="8" y="4" width="32" height="36" fill="#1C1C1E" />
      <rect x="10" y="6" width="28" height="22" fill="#F9F8F5" />
      <rect x="10" y="30" width="28" height="2" fill="#1C1C1E" />
      <rect x="28" y="32" width="8" height="2" fill="#F9F8F5" opacity="0.3" />
      <rect x="12" y="40" width="24" height="4" fill="#1C1C1E" />
      <rect x="16" y="44" width="16" height="2" fill="#1C1C1E" />
      <rect x="20" y="16" width="8" height="10" fill="#1C1C1E" />
      <rect x="21" y="18" width="6" height="6" fill="#F9F8F5" />
      <rect x="21" y="10" width="6" height="6" fill="#1C1C1E" />
      <rect x="22" y="12" width="1" height="1" fill="#F9F8F5" />
      <rect x="25" y="12" width="1" height="1" fill="#F9F8F5" />
      <rect x="23" y="14" width="2" height="1" fill="#F9F8F5" />
      <motion.g
        animate={flipperAnimation}
        transition={flipperTransition}
        style={{ transformOrigin: "28px 18px" }}
      >
        <rect x="28" y="16" width="2" height="4" fill="#1C1C1E" />
      </motion.g>
      <rect x="18" y="18" width="2" height="4" fill="#1C1C1E" />
      <rect x="20" y="26" width="3" height="1" fill="#1C1C1E" />
      <rect x="25" y="26" width="3" height="1" fill="#1C1C1E" />
    </svg>
  </div>
));
AnimatedPixelPenguin.displayName = "AnimatedPixelPenguin";

// Smoother flipper animation for standalone penguin
const wavingFlipperAnimation = {
  rotate: [-10, 10, -10],
};

const wavingFlipperTransition = {
  duration: 1.4,
  repeat: Infinity,
  ease: [0.45, 0.05, 0.55, 0.95] as const,
};

// Flashing red X animation for the offline / broken-connection state
const flashingXAnimation = {
  opacity: [1, 0.2, 1],
};

const flashingXTransition = {
  duration: 0.9,
  repeat: Infinity,
  ease: "easeInOut" as const,
};

// Retro Macintosh body with a clean (non-pixelated) WiFi + flashing X on the
// screen. Body uses the same integer-aligned rects as AnimatedPixelPenguin so
// it sits in the same visual family; the WiFi arcs and X are stroke-based
// paths to match the rest of the (lucide) icon set in the app.
export const BrokenWifiMac = memo(({ className, size = 160 }: { className?: string; size?: number }) => (
  <div className={className}>
    <svg width={size} height={size} viewBox="0 0 48 48">
      {/* Mac body — unchanged */}
      <rect x="8" y="4" width="32" height="36" fill="#1C1C1E" />
      <rect x="10" y="6" width="28" height="22" fill="#F9F8F5" />
      <rect x="10" y="30" width="28" height="2" fill="#1C1C1E" />
      <rect x="28" y="32" width="8" height="2" fill="#F9F8F5" opacity="0.3" />
      <rect x="12" y="40" width="24" height="4" fill="#1C1C1E" />
      <rect x="16" y="44" width="16" height="2" fill="#1C1C1E" />

      {/* Flashing red X — squared-off diagonals */}
      <motion.g
        animate={flashingXAnimation}
        transition={flashingXTransition}
        stroke="#ef4444"
        strokeWidth="3"
        strokeLinecap="square"
      >
        <line x1="19" y1="12" x2="29" y2="23" />
        <line x1="29" y1="12" x2="19" y2="23" />
      </motion.g>
    </svg>
  </div>
));
BrokenWifiMac.displayName = "BrokenWifiMac";

// Standalone waving penguin (matches the Mac screen penguin exactly)
export const WavingPenguin = memo(({ className, size = 64 }: { className?: string; size?: number }) => (
  <div className={className} style={{ willChange: "transform" }}>
    <svg width={size} height={size} viewBox="0 0 18 18" style={{ imageRendering: "pixelated" }}>
      <rect x="5" y="8" width="8" height="10" fill="#1C1C1E" />
      <rect x="6" y="10" width="6" height="6" fill="#F9F8F5" />
      <rect x="6" y="2" width="6" height="6" fill="#1C1C1E" />
      <rect x="7" y="4" width="1" height="1" fill="#F9F8F5" />
      <rect x="10" y="4" width="1" height="1" fill="#F9F8F5" />
      <rect x="8" y="6" width="2" height="1" fill="#F9F8F5" />
      <motion.g
        animate={wavingFlipperAnimation}
        transition={wavingFlipperTransition}
        style={{ 
          transformOrigin: "13px 10px",
          willChange: "transform"
        }}
      >
        <rect x="13" y="8" width="2" height="4" fill="#1C1C1E" />
      </motion.g>
      <rect x="3" y="10" width="2" height="4" fill="#1C1C1E" />
      <rect x="5" y="18" width="3" height="1" fill="#1C1C1E" />
      <rect x="10" y="18" width="3" height="1" fill="#1C1C1E" />
    </svg>
  </div>
));
WavingPenguin.displayName = "WavingPenguin";
