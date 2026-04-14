import { motion } from "framer-motion";

interface ContentItemProps {
    handle: string;
    content: string;
    analysis?: string;
    imageUrl?: string;
    variant: 'card' | 'inline';
    index?: number;
}

/**
 * Content Item Component - Individual Story/Bullet
 *
 * Variants:
 * - card: Full card with optional thumbnail, used in Strategic/Global sections
 * - inline: Single line format for Lightning Round
 */
export function ContentItem({
    handle,
    content,
    analysis,
    imageUrl,
    variant,
    index = 0
}: ContentItemProps) {
    if (variant === 'inline') {
        return (
            <motion.div
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3, delay: 0.05 * index }}
                className="flex items-baseline gap-2 py-1.5"
            >
                <span className="font-sans font-semibold text-primary text-sm">
                    {handle}
                </span>
                <span className="text-muted-foreground text-sm">·</span>
                <span className="font-sans text-foreground text-sm flex-1">
                    {content}
                </span>
            </motion.div>
        );
    }

    // Card variant
    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1 * index }}
            className="bg-background/50 rounded-lg p-4 border border-border/30"
        >
            <div className="flex gap-3">
                {/* Optional thumbnail */}
                {imageUrl && (
                    <div className="flex-shrink-0 w-16 h-16 rounded-md overflow-hidden bg-muted">
                        <img
                            src={imageUrl}
                            alt=""
                            className="w-full h-full object-cover"
                            onError={(e) => {
                                (e.target as HTMLImageElement).style.display = 'none';
                            }}
                        />
                    </div>
                )}

                {/* Content */}
                <div className="flex-1 min-w-0">
                    {/* Handle */}
                    <span className="font-sans font-semibold text-primary text-sm">
                        {handle}
                    </span>

                    {/* Main content */}
                    <p className="font-serif text-foreground text-base leading-relaxed mt-1">
                        {content}
                    </p>

                    {/* Contextual analysis */}
                    {analysis && (
                        <p className="font-sans text-muted-foreground text-sm italic mt-2 pl-3 border-l-2 border-muted">
                            {analysis}
                        </p>
                    )}
                </div>
            </div>
        </motion.div>
    );
}
