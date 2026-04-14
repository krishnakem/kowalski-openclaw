import { useCallback, memo, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useArchivedAnalyses } from "@/hooks/useArchivedAnalyses";
import { ease, duration } from "@/lib/animations";
import type { AnalysisObject } from "@/types/analysis";
import { DigestView } from "@/components/gazette/DigestView";

// Update Props Interface
interface GazetteScreenProps {
  analysisData?: AnalysisObject;
  analysisId?: string; // New Prop
  isArchived?: boolean;
  onClose?: () => void;
}

// ...

// Local Transitions
const buttonEntranceTransition = { duration: duration.normal, ease: ease.cinematic };
const articleEntranceTransition = { duration: duration.slow, ease: ease.cinematic };

const GazetteScreen = memo(({ onClose, analysisData: propData, analysisId: propId, isArchived: propIsArchived = false }: GazetteScreenProps) => {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { analyses, isLoaded: archivesLoaded } = useArchivedAnalyses();

  // Determine effective data
  const [effectiveData, setEffectiveData] = useState<AnalysisObject | null>(propData || null);
  const [effectiveId, setEffectiveId] = useState<string | null>(propId || null);

  useEffect(() => {
    if (propData) {
      setEffectiveData(propData);
      if (propId) {
        setEffectiveId(propId);
      }
      return;
    }
  }, [id, propData, propId, propIsArchived, analyses, archivesLoaded, navigate]);

  useEffect(() => {
    if (propData) return;

    // Waiting for archives to load is usually good, BUT
    // if we have a specific ID, we should try to fetch it regardless of the list state.
    // This bypasses the race condition where the list is stale.
    if (!archivesLoaded && !id) return;

    if (id) {
      const found = analyses.find(a => a.id === id);
      if (found) {
        setEffectiveData(found.data);
        setEffectiveId(found.id);
      } else {
        // ID provided but not found in list. 
        // INSTANT FIX: Trust the ID and try to fetch it directly later.
        console.warn(`GazetteScreen: ID ${id} not found in list. Attempting direct fetch.`);
        setEffectiveId(id);
        // Set placeholder to prevent "No Analysis Found" flash
        setEffectiveData({ id, title: "Loading...", date: new Date().toISOString(), sections: [] } as any);
      }
    } else if (archivesLoaded) {
      // Only fallback to latest if we have NO ID and list is ready.
      if (analyses.length > 0) {
        setEffectiveData(analyses[0].data);
        setEffectiveId(analyses[0].id);
      }
    }
  }, [id, propData, analyses, archivesLoaded, navigate]);

  // CONTENT FETCHING LOGIC (Lazy Load from File)
  const [isFetchingContent, setIsFetchingContent] = useState(false);

  useEffect(() => {
    const fetchContent = async () => {
      // We rely on effectiveId as the source of truth
      if (!effectiveId) return;

      // Only fetch if data is missing or incomplete
      const hasBody = !!effectiveData?.markdown || (effectiveData?.sections?.length ?? 0) > 0;
      const needsFetch = !effectiveData || !hasBody;

      if (needsFetch) {
        setIsFetchingContent(true);
        try {
          console.log("GazetteScreen: Fetching content for ", effectiveId);
          const fullContent = await window.api.analyses.getContent(effectiveId);

          if (fullContent && fullContent.data) {
            setEffectiveData(fullContent.data);
          } else {
            console.error("Fetched content was empty or invalid for ID:", effectiveId);
            // If direct fetch fails AND we aren't viewing a valid archive item, then we can redirect
            if (!analyses.find(a => a.id === effectiveId)) {
              // navigate('/archive', { replace: true }); 
            }
          }
        } catch (e) {
          console.error("Failed to fetch content:", e);
        } finally {
          setIsFetchingContent(false);
        }
      }
    };
    fetchContent();
  }, [effectiveData, effectiveId]);


  // Three-Hub Architecture: Back always goes to Archive List (with specific state)
  const handleClose = useCallback(() => {
    console.log("GazetteScreen: Back button clicked. Navigating to Archive Hierarchically.");

    // If used inline (e.g., from AnalysisArchive modal), call the provided callback
    if (onClose) {
      onClose();
    } else {
      // Route-based: Navigate "Up" to the specific Calendar View (L3)
      const d = effectiveData?.date ? new Date(effectiveData.date) : new Date();
      const year = d.getFullYear();
      const month = d.getMonth();

      navigate("/archive", {
        state: {
          viewMode: 'calendar',
          year,
          month
        }
      });
    }
  }, [onClose, navigate, effectiveData]);

  // Loading state
  // Fix: Check if sections are missing. If so, treat as loading (waiting for fetch)
  // This prevents AnalysisRenderer from crashing on undefined 'sections'
  const isDataIncomplete = effectiveData && !effectiveData.markdown && (!effectiveData.sections || effectiveData.sections.length === 0);

  if (!effectiveData || isFetchingContent || isDataIncomplete) {
    if (!archivesLoaded || isFetchingContent || isDataIncomplete) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-background">
          <div className="animate-pulse flex flex-col items-center">
            <div className="h-12 w-12 bg-muted rounded-full mb-4"></div>
            <div className="h-4 w-32 bg-muted rounded"></div>
          </div>
        </div>
      );
    }
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background text-muted-foreground">
        <p>No analysis found.</p>
        <Button variant="link" onClick={() => navigate('/archive')}>Go to Archive</Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center py-16 px-6 bg-background relative">

      {/* Back Button / Archive Button Logic */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={buttonEntranceTransition}
        className="absolute top-6 left-6 z-50"
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={handleClose}
          className="text-muted-foreground hover:bg-transparent opacity-60 hover:opacity-100 transition-opacity h-14 w-14"
        >
          {/* Always show ArrowLeft as per request if 'onClose' meant 'live view' which now goes to archive?
              Actually, the user said 'Back Arrow... leads to Archive'.
              If isArchived (browsing history), Back usually goes back to list (Archive). 
              If Live View, Back now goes to Archive.
              So basically, it always goes to Archive. */}
          <ArrowLeft className="w-6 h-6" />
        </Button>
      </motion.div>



      <motion.article
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={articleEntranceTransition}
        className="max-w-[650px] w-full"
      >
        {/* Text-focused Digest View */}
        <DigestView
          data={effectiveData}
          recordId={effectiveId || ''}
        />
      </motion.article>
    </div>
  );
});

GazetteScreen.displayName = "GazetteScreen";

export default GazetteScreen;
