import { useEffect, useMemo } from "react";
import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import { SectionCard } from "./SectionCard";
import { parseSection, getSectionVariant } from "@/lib/contentParser";
import { renderMarkdown } from "@/lib/markdown";
import { WavingPenguin } from "@/components/icons/PixelIcons";
import type { AnalysisObject } from "@/types/analysis";

interface DigestViewProps {
    data: AnalysisObject;
    recordId: string;
}

export function DigestView({
    data,
    recordId
}: DigestViewProps) {
    const dateInfo = useMemo(() => {
        const date = typeof data.date === 'string' ? new Date(data.date) : data.date;
        return {
            formatted: date.toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric'
            }),
            time: data.scheduledTime || date.toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            })
        };
    }, [data.date, data.scheduledTime]);

    const { markdownTitle, markdownBody } = useMemo(() => {
        if (!data.markdown) return { markdownTitle: null as string | null, markdownBody: null as string | null };
        const lines = data.markdown.replace(/\r\n/g, '\n').split('\n');
        let title: string | null = null;
        const bodyLines: string[] = [];
        let titleConsumed = false;
        for (const line of lines) {
            if (!titleConsumed) {
                const h1 = line.match(/^#\s+(.+)$/);
                if (h1) {
                    title = h1[1].trim();
                    titleConsumed = true;
                    continue;
                }
                // Skip leading blank lines or stray h3 subtitle (e.g., "### ... Edition №1")
                if (!line.trim()) continue;
                if (/^###\s+/.test(line)) continue;
            } else {
                // Drop a single h3 subtitle immediately following the title
                if (bodyLines.length === 0 && /^###\s+/.test(line.trim())) continue;
                if (bodyLines.length === 0 && !line.trim()) continue;
            }
            bodyLines.push(line);
        }
        // Strip trailing review-summary line ("*N story frames and M posts reviewed across K accounts.*")
        // and any trailing horizontal rule / blank lines preceding it.
        const reviewSummaryRe = /^\*?\s*\d+\s+story\s+frames?\s+and\s+(?:\d+\s+)?(?:feed\s+)?posts?\s+reviewed\s+across\s+\d+\s+accounts?\.?\s*\*?$/i;
        while (bodyLines.length) {
            const last = bodyLines[bodyLines.length - 1].trim();
            if (!last || /^-{3,}$/.test(last) || reviewSummaryRe.test(last)) {
                bodyLines.pop();
                continue;
            }
            break;
        }
        return {
            markdownTitle: title,
            markdownBody: bodyLines.join('\n').trimStart() || null,
        };
    }, [data.markdown]);

    const markdownBodyNodes = useMemo(
        () => (markdownBody ? renderMarkdown(markdownBody) : null),
        [markdownBody]
    );

    const headerTitle = markdownTitle ?? data.title;

    // Cursor-tracking tilt for the sign-off penguin (matches onboarding behavior)
    const mouseX = useMotionValue(0);
    const smoothX = useSpring(mouseX, { stiffness: 100, damping: 20, mass: 0.5 });
    const penguinX = useTransform(smoothX, (v) => v * 12);
    const penguinRotate = useTransform(smoothX, (v) => v * 8);

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            const x = (e.clientX / window.innerWidth - 0.5) * 2;
            mouseX.set(x);
        };
        window.addEventListener("mousemove", handleMouseMove);
        return () => window.removeEventListener("mousemove", handleMouseMove);
    }, [mouseX]);

    const parsedSections = useMemo(() => {
        if (data.markdown) return [];
        return data.sections.map(section => {
            const parsed = parseSection(section.heading, section.content);
            const variant = getSectionVariant(parsed);
            return { parsed, variant };
        });
    }, [data.sections, data.markdown]);

    return (
        <div className="digest-view pb-8">
            <motion.header
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, ease: "easeOut" }}
                className="text-center mb-8 px-4"
            >
                <h1 className="font-serif text-3xl md:text-4xl font-bold text-foreground leading-tight mb-4">
                    {headerTitle}
                </h1>
                <p className="font-sans text-muted-foreground text-sm">
                    {dateInfo.formatted} • {dateInfo.time}
                    {data.location && ` • ${data.location}`}
                </p>
            </motion.header>

            {markdownBodyNodes ? (
                <motion.article
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.6, ease: "easeOut" }}
                    className="px-4 max-w-[680px] mx-auto digest-prose"
                >
                    {markdownBodyNodes}
                </motion.article>
            ) : (
                <>
                    {data.subtitle && (
                        <motion.p
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ duration: 0.5, delay: 0.3 }}
                            className="font-serif text-muted-foreground text-center text-lg leading-relaxed mb-8 px-4"
                        >
                            {data.subtitle}
                        </motion.p>
                    )}

                    <div className="px-4">
                        {parsedSections.map(({ parsed, variant }, idx) => (
                            <SectionCard
                                key={idx}
                                section={parsed}
                                variant={variant}
                                recordId={recordId}
                                sectionIndex={idx}
                            />
                        ))}
                    </div>
                </>
            )}

            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.5, delay: 0.5 }}
                className="flex flex-col items-center text-center py-8 px-4"
            >
                <motion.div style={{ x: penguinX, rotate: penguinRotate }} className="mb-3">
                    <WavingPenguin size={64} />
                </motion.div>
                <p className="font-serif italic text-muted-foreground text-base">
                    You're all caught up
                </p>
            </motion.div>
        </div>
    );
}
