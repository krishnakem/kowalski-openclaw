import React, { Component, ErrorInfo, ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface Props {
    children?: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
    errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
    public state: State = {
        hasError: false,
        error: null,
        errorInfo: null,
    };

    public static getDerivedStateFromError(error: Error): State {
        // Update state so the next render will show the fallback UI.
        return { hasError: true, error, errorInfo: null };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error("Uncaught error:", error, errorInfo);
        this.setState({ errorInfo });
    }

    public render() {
        if (this.state.hasError) {
            return (
                <div className="min-h-screen flex flex-col items-center justify-center bg-destructive/5 p-6 text-center">
                    <h1 className="text-2xl font-bold text-destructive mb-4">Something went wrong.</h1>
                    <div className="bg-white p-4 rounded-md border border-destructive/20 shadow-sm max-w-2xl w-full overflow-x-auto text-left mb-6">
                        <p className="text-destructive font-mono text-sm font-bold mb-2">
                            {this.state.error?.toString()}
                        </p>
                        <pre className="text-xs text-muted-foreground whitespace-pre-wrap">
                            {this.state.errorInfo?.componentStack}
                        </pre>
                    </div>
                    <Button
                        onClick={() => window.location.href = '/'}
                        variant="default"
                    >
                        Reload Application
                    </Button>
                </div>
            );
        }

        return this.props.children;
    }
}
