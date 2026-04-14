import { motion } from "framer-motion";
import { ContentItem } from "./ContentItem";
import type { ParsedSection } from "@/lib/contentParser";

interface SectionCardProps {
    section: ParsedSection;
    variant: 'featured' | 'standard' | 'compact';
    recordId?: string;
    sectionIndex?: number;
}

/**
 * Section Card Component - Wraps a digest section
 *
 * Variants:
 * - featured: Prominent display for Strategic Interests
 * - standard: Normal display for Global Intelligence
 * - compact: Dense list for Lightning Round
 */
export function SectionCard({
    section,
    variant,
    recordId,
    sectionIndex = 0
}: SectionCardProps) {
    const isCompact = variant === 'compact';

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.15 * sectionIndex }}
            className={`
                rounded-lg overflow-hidden mb-6
                ${isCompact
                    ? 'bg-muted/30 border border-border/20'
                    : 'bg-secondary/50 border border-border/30 shadow-sm'
                }
            `}
        >
            {/* Section Header */}
            <div className={`
                px-4 py-3 border-b border-border/20
                ${variant === 'featured' ? 'bg-primary/5' : ''}
            `}>
                <div className="flex items-center gap-2">
                    {/* Emoji */}
                    {section.emoji && (
                        <span className="text-lg">{section.emoji}</span>
                    )}

                    {/* Category */}
                    <h2 className={`
                        font-sans font-semibold uppercase tracking-wide
                        ${isCompact ? 'text-xs text-muted-foreground' : 'text-sm text-foreground'}
                    `}>
                        {section.category}
                    </h2>

                    {/* Subcategory */}
                    {section.subcategory && (
                        <>
                            <span className="text-muted-foreground">:</span>
                            <span className="font-sans text-sm text-muted-foreground">
                                {section.subcategory}
                            </span>
                        </>
                    )}
                </div>
            </div>

            {/* Section Content */}
            <div className={`p-4 ${isCompact ? 'py-2' : ''}`}>
                {isCompact ? (
                    // Lightning Round: compact inline items
                    <div className="divide-y divide-border/10">
                        {section.items.map((item, idx) => (
                            <ContentItem
                                key={idx}
                                handle={item.handle}
                                content={item.content}
                                analysis={item.analysis}
                                variant="inline"
                                index={idx}
                            />
                        ))}
                    </div>
                ) : (
                    // Standard/Featured: card items with spacing
                    <div className="space-y-3">
                        {section.items.map((item, idx) => (
                            <ContentItem
                                key={idx}
                                handle={item.handle}
                                content={item.content}
                                analysis={item.analysis}
                                variant="card"
                                index={idx}
                            />
                        ))}
                    </div>
                )}
            </div>
        </motion.div>
    );
}
