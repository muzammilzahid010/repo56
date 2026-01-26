import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, X } from "lucide-react";
import { useState } from "react";

interface SessionData {
  authenticated: boolean;
  user?: {
    id: string;
    username: string;
    warningActive?: boolean;
    warningMessage?: string;
  };
}

export function WarningBanner() {
  const [dismissed, setDismissed] = useState(false);

  const { data: session } = useQuery<SessionData>({
    queryKey: ["/api/session"],
    staleTime: 30000,
  });

  if (!session?.authenticated || !session?.user?.warningActive || dismissed) {
    return null;
  }

  const warningMessage = session.user.warningMessage || 
    "You are violating our policies. We will closely monitor your account and next time if we detect this again, we will delete your account.";

  return (
    <div className="fixed top-0 left-0 right-0 z-[9999] bg-gradient-to-r from-red-600 to-red-700 text-white shadow-lg" data-testid="warning-banner">
      <div className="max-w-7xl mx-auto px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 flex-1">
            <div className="flex-shrink-0">
              <AlertTriangle className="h-6 w-6 text-yellow-300 animate-pulse" />
            </div>
            <div className="flex-1">
              <p className="font-bold text-lg" data-testid="text-warning-title">Account Warning</p>
              <p className="text-sm text-red-100" data-testid="text-warning-message">{warningMessage}</p>
            </div>
          </div>
          <button
            onClick={() => setDismissed(true)}
            className="flex-shrink-0 p-1 hover:bg-red-500 rounded transition-colors"
            aria-label="Dismiss warning"
            data-testid="button-dismiss-warning"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
