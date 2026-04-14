import { useState, useMemo, useCallback, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Search, ChevronLeft, ChevronRight, ArrowLeft } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { WavingPenguin } from "@/components/icons/PixelIcons";
import GazetteScreen from "@/components/screens/GazetteScreen";
import PageHeader from "@/components/layouts/PageHeader";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ease, duration, spring } from "@/lib/animations";
import { useArchivedAnalyses } from "@/hooks/useArchivedAnalyses";
import type { ArchivedAnalysis } from "@/types/analysis";

const formatDate = (date: Date | string): string => {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  });
};

const getWeekdayTitle = (date: Date | string): string => {
  const d = date instanceof Date ? date : new Date(date);
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  return `The ${weekday} Analysis`;
};

// Highlight matching text in search results
const highlightMatch = (text: string, query: string): React.ReactNode => {
  if (!query.trim()) return text;

  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  const parts = text.split(regex);

  return parts.map((part, i) =>
    regex.test(part) ? (
      <mark key={i} className="bg-primary/20 text-foreground rounded-sm px-0.5">
        {part}
      </mark>
    ) : (
      part
    )
  );
};

// Get match context snippets for search results
interface MatchContext {
  field: string;
  snippet: string;
}

const getMatchContext = (analysis: ArchivedAnalysis, query: string): MatchContext[] => {
  if (!query.trim()) return [];

  const q = query.toLowerCase();
  const contexts: MatchContext[] = [];
  const snippetLength = 60;

  const extractSnippet = (text: string, field: string) => {
    const lowerText = text.toLowerCase();
    const matchIndex = lowerText.indexOf(q);
    if (matchIndex === -1) return;

    const start = Math.max(0, matchIndex - snippetLength / 2);
    const end = Math.min(text.length, matchIndex + q.length + snippetLength / 2);
    let snippet = text.slice(start, end);

    if (start > 0) snippet = "..." + snippet;
    if (end < text.length) snippet = snippet + "...";

    contexts.push({ field, snippet });
  };

  // Check each section content (If loaded)
  if (analysis.data.sections) {
    analysis.data.sections.forEach((section) => {
      // Check heading
      if (section.heading.toLowerCase().includes(q)) {
        extractSnippet(section.heading, "Section Heading");
      }
      // Check content
      section.content.forEach(paragraph => {
        if (paragraph.toLowerCase().includes(q)) {
          extractSnippet(paragraph, section.heading);
        }
      });
    });
  }

  if (analysis.data.location?.toLowerCase().includes(q)) {
    extractSnippet(analysis.data.location, "Location");
  }

  // Return all contexts (no limit)
  return contexts;
};

// Collapsible match context component
const MatchContextList = ({
  contexts,
  searchQuery
}: {
  contexts: MatchContext[];
  searchQuery: string;
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const visibleCount = 3;
  const hasMore = contexts.length > visibleCount;
  const displayedContexts = isExpanded ? contexts : contexts.slice(0, visibleCount);

  if (contexts.length === 0) return null;

  return (
    <div className="mt-4 space-y-2">
      {displayedContexts.map((context, ctxIndex) => (
        <div key={ctxIndex} className="flex items-start gap-2 text-xs">
          <span className="text-primary font-sans font-medium shrink-0">
            Found in {context.field}:
          </span>
          <span className="text-muted-foreground font-sans italic">
            "{highlightMatch(context.snippet, searchQuery)}"
          </span>
        </div>
      ))}
      {hasMore && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setIsExpanded(!isExpanded);
          }}
          className="text-xs text-primary hover:text-primary/80 font-sans font-medium transition-colors flex items-center gap-1"
        >
          {isExpanded ? (
            <>Show less</>
          ) : (
            <>+{contexts.length - visibleCount} more matches</>
          )}
        </button>
      )}
    </div>
  );
};

type ViewMode = "months" | "calendar";

// Calendar component for month view
const MonthCalendar = ({
  year,
  month,
  analysesMap,
  onDateClick,
}: {
  year: number;
  month: number;
  analysesMap: Map<number, ArchivedAnalysis[]>;
  onDateClick: (analysis: ArchivedAnalysis) => void;
}) => {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayOfMonth = new Date(year, month, 1).getDay();
  const weekDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // Day cell component with popover for multiple analyses
  const DayCell = ({ day, analyses }: { day: number; analyses: ArchivedAnalysis[] }) => {
    const hasAnalysis = analyses.length > 0;
    const hasMultiple = analyses.length > 1;

    // Sort analyses by time (newest first)
    const sortedAnalyses = [...analyses].sort(
      (a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime()
    );

    const cellContent = (
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.01 * day, duration: 0.2 }}
        className={`aspect-square flex flex-col items-center justify-center rounded-lg transition-all duration-200 relative
          ${hasAnalysis
            ? "bg-primary/10 hover:bg-primary/20 cursor-pointer border-2 border-primary/30 hover:border-primary"
            : "text-muted-foreground/40 cursor-default"
          }`}
      >
        <span className={`font-sans text-lg ${hasAnalysis ? "text-foreground font-medium" : ""}`}>
          {day}
        </span>
        {hasAnalysis && (
          <div className="absolute bottom-1 flex gap-0.5">
            {/* Show dots for each analysis (max 3 visible) */}
            {sortedAnalyses.slice(0, 3).map((_, i) => (
              <span key={i} className="w-1.5 h-1.5 rounded-full bg-primary" />
            ))}
            {analyses.length > 3 && (
              <span className="text-[8px] text-primary font-medium ml-0.5">+{analyses.length - 3}</span>
            )}
          </div>
        )}
      </motion.div>
    );

    if (!hasAnalysis) {
      return cellContent;
    }

    if (!hasMultiple) {
      return (
        <button onClick={() => onDateClick(analyses[0])}>
          {cellContent}
        </button>
      );
    }

    // Multiple analyses - show popover
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button>{cellContent}</button>
        </PopoverTrigger>
        <PopoverContent
          className="w-64 p-2 bg-background border-border"
          align="center"
          sideOffset={8}
        >
          <div className="space-y-1">
            <p className="text-xs font-sans text-muted-foreground px-2 py-1">
              {analyses.length} analyses
            </p>
            {sortedAnalyses.map((analysis) => (
              <button
                key={analysis.id}
                onClick={() => onDateClick(analysis)}
                className="w-full text-left px-3 py-2 rounded-md hover:bg-muted transition-colors group"
              >
                <div className="flex items-center justify-between">
                  <span className="font-sans text-sm text-foreground group-hover:text-primary transition-colors">
                    {analysis.data.scheduledTime || "8:00 AM"}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground font-sans mt-1 line-clamp-1">
                  {analysis.leadStoryPreview}
                </p>
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    );
  };

  // Create array of day cells
  const dayCells = [];

  // Empty cells for days before the first of the month
  for (let i = 0; i < firstDayOfMonth; i++) {
    dayCells.push(<div key={`empty-${i}`} className="aspect-square" />);
  }

  // Day cells
  for (let day = 1; day <= daysInMonth; day++) {
    const analyses = analysesMap.get(day) || [];
    dayCells.push(<DayCell key={day} day={day} analyses={analyses} />);
  }

  return (
    <div className="w-full max-w-md mx-auto">
      {/* Weekday headers */}
      <div className="grid grid-cols-7 gap-2 mb-2">
        {weekDays.map((day) => (
          <div key={day} className="text-center font-sans text-xs text-muted-foreground uppercase tracking-wider py-2">
            {day}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 gap-2">
        {dayCells}
      </div>
    </div>
  );
};

const AnalysisArchive = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { analyses, getAvailableYears, MONTHS, isLoaded } = useArchivedAnalyses();

  // Memoize available years (getAvailableYears now returns stable reference)
  const availableYears = getAvailableYears();

  const [selectedAnalysis, setSelectedAnalysis] = useState<ArchivedAnalysis | null>(null);
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("months");
  const [searchQuery, setSearchQuery] = useState("");
  const [showAllResults, setShowAllResults] = useState(false);

  // Hydrate state from "Up" navigation (e.g. from Gazette teleport)
  useEffect(() => {
    // specific strict check for location state presence to avoid runtime errors
    const navState = (location.state || {}) as any;
    const { viewMode: targetView, year, month } = navState;

    if (targetView === 'calendar' && year !== undefined && month !== undefined) {
      console.log("AnalysisArchive: Hydrating state from navigation:", { year, month });
      setSelectedYear(year);
      setSelectedMonth(month);
      setViewMode('calendar');
    }
  }, [location.state]);

  // Set initial year when data loads (Defaults - only if not hydrating)
  useEffect(() => {
    const navState = (location.state || {}) as any;
    const isHydrating = navState.viewMode === 'calendar';

    if (availableYears.length > 0 && selectedYear === null && !isHydrating) {
      setSelectedYear(availableYears[0]);
    }
  }, [availableYears, selectedYear, location.state]);

  // Memoized search filter
  const matchesSearch = useCallback((analysis: ArchivedAnalysis, query: string): boolean => {
    if (!query.trim()) return true;

    const q = query.toLowerCase();
    const { data, leadStoryPreview } = analysis;

    // Early returns for common matches
    if (leadStoryPreview.toLowerCase().includes(q)) return true;
    if (data.location.toLowerCase().includes(q)) return true;

    const dateStr = formatDate(data.date).toLowerCase();
    if (dateStr.includes(q)) return true;

    const weekdayTitle = getWeekdayTitle(data.date).toLowerCase();
    if (weekdayTitle.includes(q)) return true;

    // Check sections IF AVAILABLE (Memory-based legacy)
    // New Storage: sections are not loaded in list view. Skip deep search.
    if (data.sections) {
      for (const section of data.sections) {
        if (section.heading.toLowerCase().includes(q)) return true;
        for (const p of section.content) {
          if (p.toLowerCase().includes(q)) return true;
        }
      }
    }

    return false;
  }, []);

  const handleBack = useCallback(() => {
    if (viewMode === "calendar") {
      // Level 3 -> Level 2: Go from Calendar to Month Grid
      setViewMode("months");
      setSelectedMonth(null);
      return;
    }
    // Level 2 -> Level 1: Explicitly Go Home (Fixes Loop)
    navigate("/");
  }, [viewMode, navigate]);

  const handleAnalysisClick = useCallback((analysis: ArchivedAnalysis) => {
    setSelectedAnalysis(analysis);
  }, []);

  const handleCloseAnalysis = useCallback(() => {
    setSelectedAnalysis(null);
  }, []);

  const handleMonthClick = useCallback((monthIndex: number) => {
    setSelectedMonth(monthIndex);
    setViewMode("calendar");
  }, []);

  // Memoized filtered analyses for month/year
  const currentMonthAnalyses = useMemo(() => {
    if (selectedMonth === null || selectedYear === null) return [];
    return analyses.filter((analysis) => {
      const date = new Date(analysis.data.date);
      return (
        date.getFullYear() === selectedYear &&
        date.getMonth() === selectedMonth &&
        matchesSearch(analysis, searchQuery)
      );
    });
  }, [analyses, selectedYear, selectedMonth, searchQuery, matchesSearch]);

  // Memoized months with analyses count
  const monthsWithAnalyses = useMemo(() => {
    if (selectedYear === null) return new Map<number, number>();
    const monthsMap = new Map<number, number>();
    for (const analysis of analyses) {
      const date = new Date(analysis.data.date);
      if (date.getFullYear() === selectedYear && matchesSearch(analysis, searchQuery)) {
        const month = date.getMonth();
        monthsMap.set(month, (monthsMap.get(month) || 0) + 1);
      }
    }
    return monthsMap;
  }, [analyses, selectedYear, searchQuery, matchesSearch]);

  // Check if a specific month has any analyses (unfiltered)
  const hasAnalysesInMonth = useCallback(
    (year: number, month: number) =>
      analyses.some((a) => {
        const d = new Date(a.data.date);
        return d.getFullYear() === year && d.getMonth() === month;
      }),
    [analyses]
  );

  // Create a map of day -> analyses for the calendar
  const analysesPerDay = useMemo(() => {
    const dayMap = new Map<number, ArchivedAnalysis[]>();
    if (selectedMonth === null) return dayMap;

    for (const analysis of currentMonthAnalyses) {
      const day = new Date(analysis.data.date).getDate();
      const existing = dayMap.get(day);
      if (existing) {
        existing.push(analysis);
      } else {
        dayMap.set(day, [analysis]);
      }
    }
    return dayMap;
  }, [selectedMonth, currentMonthAnalyses]);

  // Check if adjacent months have analyses
  const hasPrevMonth = useMemo(() => {
    if (selectedMonth === null || selectedYear === null) return false;
    const prevMonth = selectedMonth === 0 ? 11 : selectedMonth - 1;
    const prevYear = selectedMonth === 0 ? selectedYear - 1 : selectedYear;
    return hasAnalysesInMonth(prevYear, prevMonth);
  }, [selectedMonth, selectedYear, hasAnalysesInMonth]);

  const hasNextMonth = useMemo(() => {
    if (selectedMonth === null || selectedYear === null) return false;
    const nextMonth = selectedMonth === 11 ? 0 : selectedMonth + 1;
    const nextYear = selectedMonth === 11 ? selectedYear + 1 : selectedYear;
    return hasAnalysesInMonth(nextYear, nextMonth);
  }, [selectedMonth, selectedYear, hasAnalysesInMonth]);

  const selectedMonthName = selectedMonth !== null
    ? MONTHS[selectedMonth].full
    : "";

  // Memoized search results (only computed when searching)
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    return analyses
      .filter((analysis) => matchesSearch(analysis, searchQuery))
      .sort((a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime());
  }, [analyses, searchQuery, matchesSearch]);

  const isSearching = searchQuery.trim().length > 0;

  // Show loading state while data initializes
  if (!isLoaded) {
    return <div className="min-h-screen bg-background" />;
  }

  // Empty state
  if (analyses.length === 0) {
    return (
      <motion.div
        key="archive-empty"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: duration.normal, ease: ease.cinematic }}
        className="min-h-screen bg-background relative py-16 px-6"
      >
        <PageHeader title="Analysis Archive" onBack={handleBack} />

        <main className="max-w-2xl mx-auto px-6 py-16 text-center">
          <h2 className="font-serif text-2xl text-foreground mb-3">No analyses yet</h2>
          <p className="text-muted-foreground font-sans text-sm max-w-sm mx-auto">
            Your archive will appear here after you’ve generated analyses.
          </p>
        </main>
      </motion.div>
    );
  }

  if (selectedYear === null) {
    return <div className="min-h-screen bg-background" />;
  }

  return (
    <AnimatePresence mode="wait">
      {selectedAnalysis ? (
        <motion.div
          key="gazette"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: duration.normal, ease: ease.cinematic }}
        >
          <GazetteScreen
            onClose={handleCloseAnalysis}
            analysisData={selectedAnalysis.data}
            analysisId={selectedAnalysis.id}
            isArchived={true}
          />
        </motion.div>
      ) : (
        <motion.div
          key="archive"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: duration.normal, ease: ease.cinematic }}
          className="min-h-screen bg-background relative py-16 px-6"
        >

          <PageHeader
            title="Analysis Archive"
            onBack={handleBack}
            subtitle={isSearching ? `${searchResults.length} ${searchResults.length === 1 ? "result" : "results"} for "${searchQuery}"` : undefined}
          />

          {/* Search Bar */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15, duration: 0.4 }}
            className="max-w-2xl mx-auto px-6 mb-4"
          >
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search by date, source, or topic..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setShowAllResults(false);
                }}
                className="pl-10 bg-background border-border font-sans"
              />
            </div>
          </motion.div>

          {/* Month Subheading with Navigation - only show in calendar view */}
          {viewMode === "calendar" && selectedMonth !== null && !isSearching && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2, duration: 0.4 }}
              className="max-w-2xl mx-auto px-6 mb-4 relative"
            >
              {/* Back button aligned with search icon */}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  setViewMode("months");
                  setSelectedMonth(null);
                }}
                className="absolute left-6 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground hover:bg-transparent transition-colors h-8 w-8"
              >
                <ArrowLeft className="w-4 h-4" />
              </Button>

              {/* Centered month navigation */}
              <div className="flex items-center justify-center gap-4">
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={!hasPrevMonth}
                  onClick={() => {
                    if (selectedMonth === 0) {
                      setSelectedMonth(11);
                      setSelectedYear(selectedYear - 1);
                    } else {
                      setSelectedMonth(selectedMonth - 1);
                    }
                  }}
                  className="text-muted-foreground hover:text-foreground hover:bg-transparent transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-6 h-6" />
                </Button>

                <h2 className="text-2xl font-serif text-foreground min-w-[200px] text-center">
                  {selectedMonthName} {selectedYear}
                </h2>

                <Button
                  variant="ghost"
                  size="icon"
                  disabled={!hasNextMonth}
                  onClick={() => {
                    if (selectedMonth === 11) {
                      setSelectedMonth(0);
                      setSelectedYear(selectedYear + 1);
                    } else {
                      setSelectedMonth(selectedMonth + 1);
                    }
                  }}
                  className="text-muted-foreground hover:text-foreground hover:bg-transparent transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronRight className="w-6 h-6" />
                </Button>
              </div>
            </motion.div>
          )}

          {isSearching ? (
            /* Search Results - Flat list of all matching analyses */
            <main className="max-w-2xl mx-auto px-6 py-8">
              {searchResults.length === 0 ? (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2, duration: 0.5 }}
                  className="flex flex-col items-center justify-center py-20 text-center"
                >
                  <Search className="w-12 h-12 text-muted-foreground mb-4" />
                  <h2 className="font-serif text-xl text-foreground mb-3">
                    No Results Found
                  </h2>
                  <p className="text-muted-foreground font-sans text-sm max-w-xs leading-relaxed">
                    No analyses match "{searchQuery}".
                  </p>
                </motion.div>
              ) : (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.2, duration: 0.4 }}
                  className="space-y-6"
                >
                  {(showAllResults ? searchResults : searchResults.slice(0, 3)).map((analysis, index) => (
                    <motion.article
                      key={analysis.id}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.05 * (index + 1), duration: 0.4 }}
                      className="group cursor-pointer"
                      onClick={() => handleAnalysisClick(analysis)}
                    >
                      <div className="pb-6 border-b border-border">
                        <h2 className="font-serif text-xl text-foreground group-hover:text-primary transition-colors mb-1">
                          {highlightMatch(getWeekdayTitle(analysis.data.date), searchQuery)}
                        </h2>
                        <p className="font-sans text-xs text-muted-foreground uppercase tracking-wider mb-4">
                          {highlightMatch(formatDate(analysis.data.date), searchQuery)} at {analysis.data.scheduledTime || "8:00 AM"}{analysis.data.location ? ` • ${highlightMatch(analysis.data.location, searchQuery)}` : ''}
                        </p>
                        <div className="flex gap-2">
                          <span className="font-sans text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            {analysis.data.sections && analysis.data.sections[0] ? analysis.data.sections[0].heading + ":" : "Summary:"}
                          </span>
                          <p className="font-serif text-sm text-foreground/80 leading-relaxed line-clamp-2">
                            {highlightMatch(analysis.leadStoryPreview, searchQuery)}
                          </p>
                        </div>

                        {/* Match Context Snippets */}
                        <MatchContextList
                          contexts={getMatchContext(analysis, searchQuery)}
                          searchQuery={searchQuery}
                        />
                      </div>
                    </motion.article>
                  ))}

                  {/* Show More/Less Results Button */}
                  {searchResults.length > 3 && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.3, duration: 0.4 }}
                      className="flex justify-center pt-4"
                    >
                      <button
                        onClick={() => setShowAllResults(!showAllResults)}
                        className="text-sm text-primary hover:text-primary/80 font-sans font-medium transition-colors flex items-center gap-2 px-4 py-2 border border-primary/20 rounded-md hover:bg-primary/5"
                      >
                        {showAllResults ? (
                          <>Show less</>
                        ) : (
                          <>Show {searchResults.length - 3} more results</>
                        )}
                      </button>
                    </motion.div>
                  )}
                </motion.div>
              )}
            </main>
          ) : viewMode === "months" ? (
            <>
              {/* Year Dropdown */}
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2, duration: 0.4 }}
                className="max-w-2xl mx-auto px-6 mb-8"
              >
                <div className="flex justify-center">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        className="font-sans text-lg px-6 py-2 border-2 border-foreground/20 hover:border-foreground bg-background"
                      >
                        {selectedYear}
                        <ChevronDown className="ml-2 w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="bg-background border-border z-50">
                      {availableYears.map((year) => (
                        <DropdownMenuItem
                          key={year}
                          onClick={() => setSelectedYear(year)}
                          className={`font-sans cursor-pointer ${year === selectedYear ? "font-medium" : ""
                            }`}
                        >
                          {year}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </motion.div>

              {/* Month Grid - Only show months with analyses */}
              <main className="max-w-2xl mx-auto px-6 py-4">
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.3, duration: 0.4 }}
                  className="grid grid-cols-3 md:grid-cols-4 gap-4"
                >
                  {MONTHS.filter(month => monthsWithAnalyses.has(month.index)).map((month, index) => {
                    const analysesCount = monthsWithAnalyses.get(month.index) || 0;

                    return (
                      <motion.button
                        key={month.short}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.05 * index, duration: 0.3 }}
                        whileHover={{ y: -2, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }}
                        onClick={() => handleMonthClick(month.index)}
                        className="aspect-square border-2 p-4 flex flex-col items-center justify-center gap-2
                          transition-colors duration-200 bg-card border-foreground/20 hover:border-foreground cursor-pointer"
                      >
                        <span className="font-serif text-2xl md:text-3xl text-foreground">
                          {month.short}
                        </span>
                        <span className="font-sans text-xs text-muted-foreground">
                          {analysesCount} {analysesCount === 1 ? "analysis" : "analyses"}
                        </span>
                      </motion.button>
                    );
                  })}
                </motion.div>

                {/* No analyses for year or search */}
                {monthsWithAnalyses.size === 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2, duration: 0.5 }}
                    className="flex flex-col items-center justify-center py-12 text-center"
                  >
                    {searchQuery.trim() ? (
                      <>
                        <Search className="w-12 h-12 text-muted-foreground mb-4" />
                        <h2 className="font-serif text-xl text-foreground mb-3">
                          No Results Found
                        </h2>
                        <p className="text-muted-foreground font-sans text-sm max-w-xs leading-relaxed">
                          No analyses match "{searchQuery}" in {selectedYear}.
                        </p>
                      </>
                    ) : (
                      <>
                        <WavingPenguin size={80} />
                        <h2 className="font-serif text-xl text-foreground mt-6 mb-3">
                          No Analyses in {selectedYear}
                        </h2>
                        <p className="text-muted-foreground font-sans text-sm max-w-xs leading-relaxed">
                          Try selecting a different year.
                        </p>
                      </>
                    )}
                  </motion.div>
                )}
              </main>
            </>
          ) : (
            /* Calendar View for Selected Month */
            <main className="max-w-2xl mx-auto px-6 py-4">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2, duration: 0.4 }}
              >
                <MonthCalendar
                  year={selectedYear}
                  month={selectedMonth!}
                  analysesMap={analysesPerDay}
                  onDateClick={handleAnalysisClick}
                />

                {/* Legend */}
                <div className="flex items-center justify-center gap-4 mt-8 text-sm font-sans text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full bg-primary" />
                    <span>Analysis available</span>
                  </div>
                </div>

                {/* No analyses message */}
                {currentMonthAnalyses.length === 0 && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.3, duration: 0.4 }}
                    className="text-center mt-8"
                  >
                    <p className="text-muted-foreground font-sans text-sm">
                      No analyses found for {selectedMonthName} {selectedYear}
                    </p>
                  </motion.div>
                )}
              </motion.div>
            </main>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default AnalysisArchive;
