import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        serif: ['Instrument Serif', 'Georgia', 'serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        border: "#E6E6E6",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "#F9F8F5", // Paper
        foreground: "#1C1C1E", // Ink
        primary: {
          DEFAULT: "#1C1C1E", // Ink
          foreground: "#F9F8F5", // Paper
        },
        secondary: {
          DEFAULT: "#F5F3EE", // Card
          foreground: "#1C1C1E", // Ink
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "#E3E1DC",
          foreground: "#1C1C1E",
        },
        accent: {
          DEFAULT: "#1C1C1E",
          foreground: "#F9F8F5",
        },
        popover: {
          DEFAULT: "#F5F3EE",
          foreground: "#1C1C1E",
        },
        card: {
          DEFAULT: "#F5F3EE",
          foreground: "#1C1C1E",
        },
        ink: "#1C1C1E",
        paper: "#F9F8F5",
        cornflower: "#5A72A0",
      },
      borderRadius: {
        lg: "0rem",
        md: "0rem",
        sm: "0rem",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in-up": {
          from: { opacity: "0", transform: "translateY(20px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "blink": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
        "scan": {
          "0%, 100%": { transform: "translateY(-2px)" },
          "50%": { transform: "translateY(2px)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 0.6s ease-out forwards",
        "fade-in-up": "fade-in-up 0.8s ease-out forwards",
        "blink": "blink 1s step-end infinite",
        "scan": "scan 2s ease-in-out infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
