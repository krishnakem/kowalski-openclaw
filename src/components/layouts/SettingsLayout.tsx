import { ReactNode, memo } from "react";
import { useNavigate } from "react-router-dom";
// import { useFromScreen } from "@/hooks/useFromScreen"; // Unused
import PageHeader from "./PageHeader";

interface SettingsLayoutProps {
  title: string;
  children: ReactNode;
}

/**
 * Reusable layout for settings pages with back button and title.
 */
const SettingsLayout = memo(({ title, children }: SettingsLayoutProps) => {
  const navigate = useNavigate();

  const handleBack = () => {
    navigate(-1);
  };

  return (
    <div className="min-h-screen bg-background text-foreground py-16 px-6 relative">
      <PageHeader title={title} onBack={handleBack} />

      <div className="max-w-md mx-auto space-y-8 text-center">
        {children}
      </div>
    </div>
  );
});

SettingsLayout.displayName = "SettingsLayout";

export default SettingsLayout;
