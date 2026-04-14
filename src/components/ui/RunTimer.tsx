import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

/**
 * RunTimer - Shows a countdown when a run is in progress.
 *
 * Displays a floating pill at the top of the screen showing:
 * "Browsing: 90:00" -> countdown -> "0:00"
 *
 * Disappears when the run completes (or on error).
 */
export function RunTimer() {
    const [isRunning, setIsRunning] = useState(false);
    const [endTime, setEndTime] = useState<number | null>(null);
    const [remaining, setRemaining] = useState(0);

    useEffect(() => {
        const unsubStart = window.api.settings.onRunStarted(({ durationMs, startTime }) => {
            console.log(`Run started: ${durationMs / 1000}s timer`);
            setIsRunning(true);
            setEndTime(startTime + durationMs);
            setRemaining(durationMs);
        });

        const unsubComplete = window.api.settings.onRunComplete(() => {
            console.log('Run complete');
            setIsRunning(false);
            setEndTime(null);
        });

        return () => {
            unsubStart();
            unsubComplete();
        };
    }, []);

    // Countdown ticker - updates every second
    useEffect(() => {
        if (!isRunning || !endTime) return;

        const interval = setInterval(() => {
            const now = Date.now();
            const left = Math.max(0, endTime - now);
            setRemaining(left);

            if (left === 0) {
                setIsRunning(false);
            }
        }, 1000);

        return () => clearInterval(interval);
    }, [isRunning, endTime]);

    // Format milliseconds as MM:SS
    const formatTime = (ms: number) => {
        const totalSeconds = Math.ceil(ms / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    };

    return (
        <AnimatePresence>
            {isRunning && (
                <motion.div
                    initial={{ opacity: 0, y: -20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -20 }}
                    transition={{ duration: 0.3, ease: 'easeOut' }}
                    className="fixed top-4 left-1/2 -translate-x-1/2 z-50"
                >
                    <div className="bg-primary text-primary-foreground px-4 py-2 rounded-full shadow-lg flex items-center gap-2">
                        <span className="animate-pulse">🔍</span>
                        <span className="font-mono text-lg font-semibold">
                            Browsing: {formatTime(remaining)}
                        </span>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
