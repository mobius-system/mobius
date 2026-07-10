import { useState } from "react";
import { DesktopShell } from "./components/DesktopShell";
import { LoginScreen, LoginValues } from "./components/LoginScreen";

type SessionState =
  | { status: "anonymous" }
  | { status: "authenticated"; values: LoginValues };

export function App() {
  const [session, setSession] = useState<SessionState>({ status: "anonymous" });

  if (session.status === "anonymous") {
    return <LoginScreen onLogin={(values) => setSession({ status: "authenticated", values })} />;
  }

  return <DesktopShell login={session.values} onLogout={() => setSession({ status: "anonymous" })} />;
}
