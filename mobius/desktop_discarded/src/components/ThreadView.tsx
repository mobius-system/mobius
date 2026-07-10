import { ChevronDown, Copy, Mic, Plus, Send, Sparkles, Undo2 } from "lucide-react";
import { activeChange, modelLabel } from "../mock/transcript";

interface ThreadViewProps {
  onMockAction: (message: string) => void;
}

export function ThreadView({ onMockAction }: ThreadViewProps) {
  return (
    <section className="thread-view">
      <div className="thread-scroll">
        <p className="edited-line">
          Edited <a>{activeChange.file}</a>{" "}
          <span className="diff-add">+{activeChange.additions}</span>{" "}
          <span className="diff-del">-{activeChange.deletions}</span>
        </p>

        <article className="assistant-message">
          <p>
            理解，这确实挺让人困惑的。根因是我们最初的脚本在 <code>body</code>{" "}
            还没创建时就执行了，结果没有挂上 <code>copy</code> 监听。
          </p>
          <p>
            我已经修复：改成在 <code>DOMContentLoaded</code> 后再初始化，这样就能确保{" "}
            <code>body</code> 和 <code>#articleContent</code> 都存在。
          </p>

          <h3>修复点</h3>
          <ul>
            <li>
              <a>{activeChange.file}</a>
              <ul>
                <li>
                  改成在 DOM Ready 后初始化 <code>copy</code> 监听
                </li>
              </ul>
            </li>
          </ul>

          <p>你刷新页面再试一下复制（普通文本超过 200 字），应该会看到提示并被截断。</p>
          <p>如果还是不生效，我接下来会帮你检查：</p>
          <ol>
            <li>
              页面是否加载了 <a>{activeChange.file}</a>
            </li>
            <li>
              <code>toastr</code> 是否正常（即便 toastr 不工作，截断也该生效）
            </li>
          </ol>
          <p>要我顺便加一个调试日志（只在专栏页生效）帮你确认事件是否触发吗？</p>

          <button className="copy-button" aria-label="Copy message" onClick={() => onMockAction("复制内容是 mock 行为")}>
            <Copy size={20} />
          </button>

          <div className="change-card">
            <div className="change-card-header">
              <strong>1 file changed</strong>
              <button onClick={() => onMockAction("Undo 是 mock 按钮")}>
                Undo
                <Undo2 size={19} />
              </button>
            </div>
            <div className="change-file">
              <span>{activeChange.fullPath}</span>
              <span className="diff-add">+{activeChange.additions}</span>
              <span className="diff-del">-{activeChange.deletions}</span>
            </div>
          </div>
        </article>
      </div>

      <Composer onMockAction={onMockAction} />
    </section>
  );
}

function Composer({ onMockAction }: ThreadViewProps) {
  return (
    <div className="composer">
      <textarea placeholder="Ask for follow-up changes" rows={3} />
      <div className="composer-toolbar">
        <div className="composer-left">
          <button aria-label="Attach" onClick={() => onMockAction("附件暂未接入")}>
            <Plus size={31} />
          </button>
          <button className="model-picker" onClick={() => onMockAction("模型选择暂未接入")}>
            <span>{modelLabel}</span>
            <span className="model-tier">High</span>
            <ChevronDown size={21} />
          </button>
        </div>
        <div className="composer-right">
          <button aria-label="Tools" onClick={() => onMockAction("工具暂未接入")}>
            <Sparkles size={22} />
          </button>
          <button aria-label="Voice" onClick={() => onMockAction("语音暂未接入")}>
            <Mic size={25} />
          </button>
          <button className="send-button" aria-label="Send" onClick={() => onMockAction("发送是 mock 行为")}>
            <Send size={24} />
          </button>
        </div>
      </div>
    </div>
  );
}
