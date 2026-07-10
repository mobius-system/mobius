import { ChevronDown, GitBranch, Laptop, LoaderCircle } from "lucide-react";
import { LoginValues } from "./LoginScreen";
import { branchLabel, workspaceMode } from "../mock/transcript";

interface StatusBarProps {
  login: LoginValues;
}

export function StatusBar({ login }: StatusBarProps) {
  return (
    <footer className="statusbar">
      <div className="statusbar-left" title={login.url}>
        <Laptop size={21} />
        <span>{workspaceMode}</span>
        <ChevronDown size={18} />
      </div>
      <div className="statusbar-right">
        <GitBranch size={22} />
        <span>{branchLabel}</span>
        <LoaderCircle size={22} className="status-spinner" />
      </div>
    </footer>
  );
}
