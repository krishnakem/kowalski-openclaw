import { ReactNode, memo } from "react";
import { motion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ease, duration } from "@/lib/animations";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  leftAction?: ReactNode;
  rightAction?: ReactNode;
  className?: string;
}

// Animation variants defined outside component
const headerEntranceVariants = {
  initial: { opacity: 0, y: -10 },
  animate: { opacity: 1, y: 0 },
};

const contentVariants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
};

/**
 * Shared page header component for consistent styling across all pages.
 * Includes title, optional subtitle, back button, and action slots.
 */
const PageHeader = memo(({
  title,
  subtitle,
  onBack,
  leftAction,
  rightAction,
  className = "",
}: PageHeaderProps) => {
  const entranceTransition = { delay: 0.3, duration: duration.slow, ease: ease.cinematic };
  const contentTransition = { delay: 0.2, duration: 0.6 };

  return (
    <>
      {/* Left Action (Back button or custom) */}
      {(onBack || leftAction) && (
        <motion.div
          variants={headerEntranceVariants}
          initial="initial"
          animate="animate"
          transition={entranceTransition}
          className="absolute top-6 left-6 z-10"
        >
          {leftAction || (
            <Button
              variant="ghost"
              size="icon"
              onClick={onBack}
              className="text-muted-foreground hover:bg-transparent opacity-60 hover:opacity-100 transition-opacity h-14 w-14"
            >
              <ArrowLeft className="w-6 h-6" />
            </Button>
          )}
        </motion.div>
      )}

      {/* Right Action */}
      {rightAction && (
        <motion.div
          variants={headerEntranceVariants}
          initial="initial"
          animate="animate"
          transition={entranceTransition}
          className="absolute top-6 right-6 z-10"
        >
          {rightAction}
        </motion.div>
      )}

      {/* Header Content */}
      <motion.header
        variants={contentVariants}
        initial="initial"
        animate="animate"
        transition={contentTransition}
        className={`text-center mb-4 ${className}`}
      >
        <h1 className="text-5xl md:text-6xl font-serif text-foreground mb-2 tracking-tight">
          {title}
        </h1>
        {subtitle && (
          <p className="font-sans text-muted-foreground text-sm">
            {subtitle}
          </p>
        )}
      </motion.header>
    </>
  );
});

PageHeader.displayName = "PageHeader";

export default PageHeader;
