import { useState, useEffect, useCallback, useMemo } from "react";
import type { AnalysisObject, ArchivedAnalysis } from "@/types/analysis";
import { MONTHS } from "@/lib/data/archiveData";
import type { SettingsData } from "@/hooks/useSettings";

const MAX_ANALYSES_PER_DAY = 2;

const getDayKey = (date: Date): string => {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

const enforceMaxPerDay = (analyses: ArchivedAnalysis[]): ArchivedAnalysis[] => {
  const dayMap = new Map<string, ArchivedAnalysis[]>();

  for (const analysis of analyses) {
    // Ensure date is a Date object (serialization might make it string)
    const dateObj = analysis.data.date instanceof Date ? analysis.data.date : new Date(analysis.data.date);
    const key = getDayKey(dateObj);
    const existing = dayMap.get(key);
    if (existing) {
      existing.push(analysis);
    } else {
      dayMap.set(key, [analysis]);
    }
  }

  const flattened: ArchivedAnalysis[] = [];
  dayMap.forEach((group) => {
    if (group.length <= MAX_ANALYSES_PER_DAY) {
      flattened.push(...group);
    } else {
      group.sort((a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime());
      flattened.push(...group.slice(0, MAX_ANALYSES_PER_DAY));
    }
  });

  return flattened.sort((a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime());
};

export const useArchivedAnalyses = () => {
  const [analyses, setAnalyses] = useState<ArchivedAnalysis[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const loadAnalyses = async () => {
      try {
        const stored = await window.api.analyses.get();
        if (Array.isArray(stored)) {
          // Hydrate dates
          const hydrated = stored.map((a: any) => ({
            ...a,
            data: {
              ...a.data,
              date: a.data.date instanceof Date ? a.data.date : new Date(a.data.date)
            }
          }));
          setAnalyses(hydrated);
        }
      } catch (e) {
        console.error("Failed to load archived analyses:", e);
      } finally {
        setIsLoaded(true);
      }
    };
    loadAnalyses();
  }, []);

  const saveAnalyses = async (updated: ArchivedAnalysis[]) => {
    await window.api.analyses.set(updated);
    setAnalyses(updated);
  };

  const addAnalysis = useCallback(async (analysisData: AnalysisObject) => {
    const newAnalysis: ArchivedAnalysis = {
      id: `analysis-${Date.now()}`,
      data: analysisData,
      // Use first paragraph of first section as preview
      leadStoryPreview: analysisData.sections[0]?.content[0]?.slice(0, 100) + "..." || "No summary available",
    };

    const updated = enforceMaxPerDay([newAnalysis, ...analyses]);
    await saveAnalyses(updated);

    return newAnalysis;
  }, [analyses]);

  const clearAnalyses = useCallback(async () => {
    await saveAnalyses([]);
  }, []);

  const seedDemoAnalyses = useCallback(async (settings: SettingsData, daysBack: number = 7) => {
    const { generateScheduledDemoAnalyses } = await import("@/lib/generateDemoAnalyses");
    const demoData = generateScheduledDemoAnalyses(settings, daysBack);

    // Ensure uniqueness by checking existing count
    const newAnalyses: ArchivedAnalysis[] = demoData.map((data, index) => ({
      id: `analysis-demo-${Date.now()}-${index}`,
      data,
      leadStoryPreview: data.sections[0]?.content[0]?.slice(0, 100) + "..." || "No summary available",
    }));

    // Merge with existing but apply limit
    // Note: enforceMaxPerDay takes care of merging limits
    // But we need to pass current state.
    // Since this is async/state based, we must rely on 'analyses' dependency or functional update?
    // We can't do functional update easily with async IPC save.
    // We'll rely on the optimistic update pattern or just use valid closure.
    // Ideally we re-fetch effectively, but merging current 'analyses' is fine.

    const updated = enforceMaxPerDay([...newAnalyses, ...analyses]);
    await saveAnalyses(updated);
  }, [analyses]);

  // Memoized derived state
  const availableYears = useMemo((): number[] => {
    const yearsSet = new Set<number>();
    for (const analysis of analyses) {
      const d = new Date(analysis.data.date);
      yearsSet.add(d.getFullYear());
    }
    return Array.from(yearsSet).sort((a, b) => b - a);
  }, [analyses]);

  // True whenever any archived analysis exists (today or earlier).
  // Drives the archive button visibility.
  const hasPastAnalyses = useMemo(() => analyses.length > 0, [analyses]);

  // Stable reference for getAvailableYears
  const getAvailableYears = useCallback(() => availableYears, [availableYears]);

  return {
    analyses,
    addAnalysis,
    clearAnalyses,
    seedDemoAnalyses,
    hasPastAnalyses,
    isLoaded,
    getAvailableYears,
    MONTHS,
  };
};
export { type ArchivedAnalysis };
