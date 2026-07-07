import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { LoginValues } from "./LoginScreen";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { ThreadView } from "./ThreadView";
import { TopBar } from "./TopBar";

interface DesktopShellProps {
  login: LoginValues;
  onLogout: () => void;
}

export function DesktopShell({ login, onLogout }: DesktopShellProps) {
  const [toast, setToast] = useState<string | null>(null);

  function showMockToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 1800);
  }

  return (
    <main className="desktop-shell">
      <Sidebar onLogout={onLogout} onMockAction={showMockToast} />
      <section className="workspace">
        <TopBar onMockAction={showMockToast} />
        <ThreadView onMockAction={showMockToast} />
        <StatusBar login={login} />
      </section>

      {toast && (
        <div className="mock-toast" role="status">
          <CheckCircle2 size={17} />
          {toast}
        </div>
      )}
    </main>
  );
}
