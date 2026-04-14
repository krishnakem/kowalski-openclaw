import { useLocation, useNavigate } from "react-router-dom";

/**
 * Hook to extract and manage the "from" screen state for navigation.
 * Used to track which screen the user came from for back navigation.
 */
export const useFromScreen = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const fromScreen = (location.state as { from?: string })?.from;

  const navigateBack = (path: string) => {
    navigate(path, { state: { from: fromScreen } });
  };

  return { fromScreen, navigateBack };
};
