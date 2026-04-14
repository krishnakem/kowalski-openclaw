import { Toaster } from "@/components/ui/toaster";
import { SettingsProvider } from "@/contexts/SettingsContext";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { BrowserRouter, Routes, Route, useNavigate } from "react-router-dom";
import { lazy, Suspense, useEffect } from "react";
import Index from "./pages/Index";
import NotFound from "./pages/NotFound";


// Lazy-loaded routes for better initial bundle size
// Direct imports (Critical Paths)
import AnalysisArchive from "./pages/AnalysisArchive";
import GazetteScreen from "./components/screens/GazetteScreen";

const Settings = lazy(() => import("./pages/Settings"));
const ApiSettings = lazy(() => import("./pages/settings/ApiSettings"));
const PersonalSettings = lazy(() => import("./pages/settings/PersonalSettings"));

const queryClient = new QueryClient();

// Minimal loading fallback
const PageLoading = () => (
  <div className="min-h-screen bg-background" />
);

import { useSettings } from "@/hooks/useSettings";

const AppRoutes = () => {
  const navigate = useNavigate();
  const { settings, patchSettings } = useSettings();

  // Global Listener: Force Navigation when Analysis is Ready
  useEffect(() => {
    const unsubscribe = window.api.settings.onAnalysisReady((newAnalysis: any) => {
      console.log("Forced navigation to Analysis Ready screen (Global Listener).", newAnalysis?.id);

      // GUARD: Ignore if user hasn't completed onboarding
      if (!settings.hasOnboarded) {
        return;
      }

      // update Global Settings to ensure UI reflects ready state
      patchSettings({
        analysisStatus: 'ready',
        lastAnalysisDate: new Date().toISOString()
      });

      // Force navigate to home (which renders AnalysisReady based on status)
      navigate('/');
    });

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [patchSettings, settings.hasOnboarded, navigate]);

  return (
    <Suspense fallback={<PageLoading />}>
      <Routes>
        <Route path="/" element={<Index />} />
        <Route path="/onboarding" element={<Index />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/personal" element={<PersonalSettings />} />
        <Route path="/settings/api" element={<ApiSettings />} />
        <Route path="/archive/:id" element={<GazetteScreen />} />
        <Route path="/archive" element={<AnalysisArchive />} />
        {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <ErrorBoundary>
        <SettingsProvider>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </SettingsProvider>
      </ErrorBoundary>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
