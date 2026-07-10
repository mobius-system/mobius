import { FormEvent, useMemo, useState } from "react";
import { ArrowRight, LockKeyhole, Server, UserRound } from "lucide-react";

export interface LoginValues {
  url: string;
  username: string;
  password?: string;
}

interface LoginScreenProps {
  onLogin: (values: LoginValues) => void;
}

export function LoginScreen({ onLogin }: LoginScreenProps) {
  const [url, setUrl] = useState("http://127.0.0.1:3301");
  const [username, setUsername] = useState("fuqingxu");
  const [password, setPassword] = useState("");

  const canSubmit = useMemo(() => url.trim().length > 0 && username.trim().length > 0, [url, username]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    onLogin({
      url: url.trim(),
      username: username.trim(),
      password: password.trim() || undefined,
    });
  }

  return (
    <main className="login-screen">
      <form className="login-panel" onSubmit={handleSubmit}>
        <div className="login-brand">
          <div className="login-mark">M</div>
          <div>
            <h1>Mobius Desktop</h1>
            <p>连接一个工作台，进入桌面端 mock 界面。</p>
          </div>
        </div>

        <label className="login-field">
          <span>服务 URL</span>
          <div className="input-with-icon">
            <Server size={18} />
            <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://127.0.0.1:3301" />
          </div>
        </label>

        <label className="login-field">
          <span>用户名</span>
          <div className="input-with-icon">
            <UserRound size={18} />
            <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="username" />
          </div>
        </label>

        <label className="login-field">
          <span>密码（可选）</span>
          <div className="input-with-icon">
            <LockKeyhole size={18} />
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="不填写也可进入 mock"
              type="password"
            />
          </div>
        </label>

        <button className="login-submit" disabled={!canSubmit} type="submit">
          进入
          <ArrowRight size={18} />
        </button>
      </form>
    </main>
  );
}
