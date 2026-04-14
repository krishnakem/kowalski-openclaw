import type { AnalysisObject, AnalysisSection } from "@/types/analysis";
import type { SettingsData } from "@/hooks/useSettings";

// Sample data pools
const circleUpdatePool = [
  "Sarah got engaged in Kyoto",
  "Mike posted 3 photos from the launch",
  "Elena started a new role at Stripe",
  "James is traveling through Portugal",
  "Lisa launched her new podcast",
  "Carlos shared photos from his family gathering",
  "Priya ran her first 10K",
  "David shared holiday photos from Colorado",
  "Anna announced her engagement",
  "Tom completed his marathon goal",
  "Rachel got promoted to senior engineer",
  "Chris moved to Seattle",
  "Nina completed her morning yoga streak - 100 days!",
  "Alex launched a new startup",
];

const worldUpdatePool = [
  "Apple's latest AI features transform how users interact with their devices, bringing contextual awareness to everyday tasks.",
  "Tech stocks rally as investors bet on continued AI momentum heading into the new year.",
  "The future of wearables looks increasingly health-focused as new sensors enable continuous monitoring.",
  "Morning markets show optimism as Asian trading closes higher across the board.",
  "Early reports suggest holiday gadget sales exceeded expectations.",
  "Supply chain improvements lead to shorter delivery times this holiday season.",
  "Smart home devices dominate post-holiday returns as gift recipients upgrade.",
  "New open-source language models challenge proprietary alternatives in benchmark tests.",
  "Gaming consoles see record holiday sales as new exclusive titles drive demand.",
  "Asian markets open strong following Christmas holiday break.",
  "The startup ecosystem sees renewed investor confidence as AI companies demonstrate sustainable business models.",
  "Holiday tech gifts trend toward privacy-focused devices as consumers become more security conscious.",
];

const pickRandom = <T>(arr: T[], count: number): T[] => {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
};

const generateAnalysis = (date: Date, location: string): AnalysisObject => {
  const circleUpdates = pickRandom(circleUpdatePool, 3);
  const worldUpdates = pickRandom(worldUpdatePool, 3);

  const sections: AnalysisSection[] = [
    {
      heading: "The Circle",
      content: circleUpdates.map(u => `• ${u}`)
    },
    {
      heading: "The World",
      content: worldUpdates
    }
  ];

  const dayName = date.toLocaleDateString("en-US", { weekday: "long" });
  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  return {
    title: `The ${dayName} Analysis`,
    subtitle: `${date.toLocaleDateString()} · ${location}`,
    date: date.toISOString(),
    location,
    scheduledTime: timeStr,
    sections
  };
};

export const generateScheduledDemoAnalyses = (
  settings: SettingsData,
  daysBack: number = 7
): AnalysisObject[] => {
  const analyses: AnalysisObject[] = [];
  const now = new Date();
  const location = settings.location || "Cupertino";

  for (let daysAgo = 1; daysAgo <= daysBack; daysAgo++) {
    const date = new Date(now);
    date.setDate(date.getDate() - daysAgo);
    date.setHours(8, 0, 0, 0);
    analyses.push(generateAnalysis(date, location));
  }

  return analyses;
};
