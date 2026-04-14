/**
 * Cinematic Animation System
 * Unified animation presets for smooth, consistent animations across the app
 */

// Cinematic easing curves
export const ease = {
  // Smooth deceleration - feels natural and elegant
  cinematic: [0.22, 1, 0.36, 1] as const,
  // Gentle ease for subtle movements
  gentle: [0.4, 0, 0.2, 1] as const,
  // Snappy for interactive elements
  snappy: [0.25, 0.46, 0.45, 0.94] as const,
};

// Duration presets (in seconds)
export const duration = {
  fast: 0.25,
  normal: 0.4,
  slow: 0.6,
  slower: 0.8,
  page: 0.7,
};

// Spring presets for bouncy, organic animations
export const spring = {
  // Gentle spring for large elements, cards
  gentle: {
    type: "spring" as const,
    stiffness: 200,
    damping: 25,
    mass: 1,
  },
  // Snappy spring for buttons, small interactive elements
  snappy: {
    type: "spring" as const,
    stiffness: 400,
    damping: 30,
  },
  // Bouncy spring for success states, celebrations
  bouncy: {
    type: "spring" as const,
    stiffness: 300,
    damping: 15,
  },
  // Soft spring for subtle movements
  soft: {
    type: "spring" as const,
    stiffness: 150,
    damping: 20,
    mass: 0.8,
  },
};

// Stagger configuration for lists
export const stagger = {
  fast: 0.03,
  normal: 0.05,
  slow: 0.08,
};

// Common animation variants
export const fadeInUp = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -10 },
};

export const fadeIn = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
};

export const fadeInScale = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.98 },
};

export const slideInFromRight = {
  initial: { opacity: 0, x: 30 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -30 },
};

// Page transition variants
export const pageTransition = {
  initial: { opacity: 0, y: 20, scale: 0.98 },
  animate: { 
    opacity: 1, 
    y: 0, 
    scale: 1,
    transition: {
      duration: duration.page,
      ease: ease.cinematic,
    },
  },
  exit: { 
    opacity: 0, 
    y: -15,
    scale: 0.99,
    transition: {
      duration: duration.normal,
      ease: ease.cinematic,
    },
  },
};

// Container variants for staggered children
export const staggerContainer = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: stagger.normal,
      delayChildren: 0.1,
    },
  },
};

// Child variants for staggered animations
export const staggerChild = {
  hidden: { opacity: 0, y: 15 },
  visible: {
    opacity: 1,
    y: 0,
    transition: spring.gentle,
  },
};

// Card variants with hover effects
export const cardVariants = {
  hidden: { opacity: 0, y: 12, scale: 0.98 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: spring.gentle,
  },
};

// Hover/tap presets for interactive elements
export const hoverScale = {
  whileHover: { scale: 1.02 },
  whileTap: { scale: 0.98 },
  transition: spring.snappy,
};

export const hoverLift = {
  whileHover: { y: -4, boxShadow: "0 10px 30px -10px rgba(0,0,0,0.15)" },
  transition: { duration: duration.fast, ease: ease.gentle },
};

export const hoverLiftSmall = {
  whileHover: { y: -2, boxShadow: "0 6px 16px rgba(0,0,0,0.08)" },
  transition: { duration: duration.fast, ease: ease.gentle },
};

// Button entrance animation
export const buttonEntrance = {
  initial: { opacity: 0, y: 10 },
  animate: { 
    opacity: 1, 
    y: 0,
    transition: {
      ...spring.snappy,
      delay: 0.2,
    },
  },
};

// Icon entrance animation
export const iconEntrance = {
  initial: { opacity: 0, scale: 0.8 },
  animate: {
    opacity: 1,
    scale: 1,
    transition: spring.bouncy,
  },
};

// List item animation with index-based delay
export const listItemAnimation = (index: number) => ({
  initial: { opacity: 0, x: -10 },
  animate: { 
    opacity: 1, 
    x: 0,
    transition: {
      ...spring.gentle,
      delay: index * stagger.normal,
    },
  },
});

// Section reveal animation
export const sectionReveal = (delay: number = 0) => ({
  initial: { opacity: 0, y: 20 },
  animate: { 
    opacity: 1, 
    y: 0,
    transition: {
      duration: duration.slow,
      ease: ease.cinematic,
      delay,
    },
  },
});

// Penguin wave animation - slower and more organic
export const penguinWave = {
  animate: { rotate: [-15, 15, -15] },
  transition: {
    duration: 1.2,
    repeat: Infinity,
    ease: "easeInOut",
  },
};

// Subtle floating animation for ambient elements
export const floatingAnimation = {
  animate: {
    y: [0, -6, 0],
  },
  transition: {
    duration: 3,
    repeat: Infinity,
    ease: "easeInOut",
  },
};

// Breathing/pulse animation for emphasis
export const breathingAnimation = {
  animate: {
    scale: [1, 1.02, 1],
    opacity: [1, 0.95, 1],
  },
  transition: {
    duration: 4,
    repeat: Infinity,
    ease: "easeInOut",
  },
};
