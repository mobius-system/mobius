import {
  ChevronDown,
  FilePlus2,
  MoreHorizontal,
  Play,
  SlidersHorizontal,
  SquareCode,
  SquareTerminal,
} from "lucide-react";

interface TopBarProps {
  onMockAction: (message: string) => void;
}

export function TopBar({ onMockAction }: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <h2>Fix table ...</h2>
        <span>paic</span>
        <button aria-label="More thread actions" onClick={() => onMockAction("更多线程操作暂未接入")}>
          <MoreHorizontal size={24} />
        </button>
      </div>

      <div className="topbar-actions">
        <button className="icon-button" aria-label="Run" onClick={() => onMockAction("运行是 mock 按钮")}>
          <Play size={25} />
        </button>
        <button className="pill-button" onClick={() => onMockAction("Open 是 mock 按钮")}>
          <SquareCode size={23} className="jetbrains-icon" />
          <span>Open</span>
          <ChevronDown size={19} />
        </button>
        <button className="pill-button" onClick={() => onMockAction("Commit 是 mock 按钮")}>
          <SlidersHorizontal size={23} />
          <span>Commit</span>
          <ChevronDown size={19} />
        </button>
        <div className="topbar-divider" />
        <button className="icon-button" aria-label="Terminal" onClick={() => onMockAction("终端暂未接入")}>
          <SquareTerminal size={23} />
        </button>
        <button className="icon-button" aria-label="Changes" onClick={() => onMockAction("变更面板暂未接入")}>
          <FilePlus2 size={23} />
        </button>
        <div className="total-diff">
          <span className="diff-add">+109</span>
          <span className="diff-del">-49</span>
        </div>
      </div>
    </header>
  );
}
