import { memo } from "react";
import { motion } from "framer-motion";
import { AnalysisObject } from "@/mocks/sampleAnalysis";

interface AnalysisRendererProps {
    data: AnalysisObject;
}

const sectionTransition = { duration: 0.8, ease: [0.22, 1, 0.36, 1] as const }; // Cinematic ease

export const AnalysisRenderer = memo(({ data }: AnalysisRendererProps) => {
    if (!data || !data.sections) return null;

    return (
        <article className="max-w-[65ch] w-full mx-auto bg-background">
            {/* Sections Loop */}
            {data.sections.map((section, index) => (
                <motion.section
                    key={index}
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, margin: "-50px" }}
                    transition={{ ...sectionTransition, delay: index * 0.1 }}
                    className="mb-12"
                >
                    {/* Section Heading */}
                    <h2 className="text-3xl font-serif text-foreground mb-6 tracking-tight">
                        {section.heading}
                    </h2>

                    {/* Paragraphs */}
                    <div>
                        {section.content.map((paragraph, pIndex) => (
                            <p
                                key={pIndex}
                                className={`text-foreground font-serif text-lg leading-relaxed mb-6 ${pIndex === 0 ? "drop-cap" : ""
                                    }`}
                            >
                                {paragraph}
                            </p>
                        ))}
                    </div>

                    {/* Divider (except for last item) */}
                    {index < data.sections.length - 1 && (
                        <div className="divider mt-12 origin-left" />
                    )}
                </motion.section>
            ))}
        </article>
    );
});

AnalysisRenderer.displayName = "AnalysisRenderer";
