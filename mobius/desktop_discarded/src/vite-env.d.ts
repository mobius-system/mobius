/// <reference types="vite/client" />

interface DesktopShellApi {
  platform: string;
  versions: {
    electron: string;
    chrome: string;
  };
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
}

interface Window {
  desktopShell?: DesktopShellApi;
}
