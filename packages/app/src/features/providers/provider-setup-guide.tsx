import { invoke } from "@tauri-apps/api/core";
import { ArrowUpRight, Terminal } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

type ProviderSetupGuideProps = { providerId: string };

const guides: Record<string, { command: (windows: boolean) => string; authKey: string; url: string }> = {
  pi: {
    command: (windows) =>
      windows
        ? "npm install -g --ignore-scripts @earendil-works/pi-coding-agent"
        : "curl -fsSL https://pi.dev/install.sh | sh",
    authKey: "安装后运行 pi 并使用 /login 配置模型服务。",
    url: "https://pi.dev/docs/latest/quickstart",
  },
  claude: {
    command: () => "npm install -g @anthropic-ai/claude-code",
    authKey: "安装后运行 claude 并完成登录。",
    url: "https://docs.anthropic.com/en/docs/claude-code/getting-started",
  },
  codex: {
    command: (windows) =>
      windows ? "npm install -g @openai/codex" : "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    authKey: "安装后运行 codex 并完成登录。",
    url: "https://developers.openai.com/codex/cli",
  },
  opencode: {
    command: () => "npm install -g @opencode/cli",
    authKey: "安装后运行 opencode 并使用 /connect 配置模型服务。",
    url: "https://docs.opencode.ai/docs/installation",
  },
  qoder: {
    command: (windows) =>
      windows ? "irm https://qoder.com/install.ps1 | iex" : "curl -fsSL https://qoder.com/install | bash",
    authKey: "安装后运行 qoder 并完成登录。",
    url: "https://docs.qoder.com/cli/installation",
  },
  zcode: {
    command: () => "npm install -g zcode-acp-server",
    authKey: "ZCode 需要先安装并登录 ZCode。此命令安装社区维护的 ACP 连接器，Vagus 会通过它连接 ZCode。",
    url: "https://github.com/william0wang/zcode-acp",
  },
};

export function ProviderSetupGuide({ providerId }: ProviderSetupGuideProps) {
  const { t } = useTranslation();
  const guide = guides[providerId];
  const windows = useMemo(() => /Windows/u.test(navigator.userAgent), []);
  if (!guide) return null;

  return (
    <aside className="provider-setup-guide">
      <header>
        <Terminal size={15} aria-hidden="true" />
        <strong>{t("如何连接")}</strong>
      </header>
      <p>{t("安装并配置本机 CLI 后，返回此处刷新模型目录。")}</p>
      <div className="provider-setup-command">
        <span>{t("安装命令")}</span>
        <code>{guide.command(windows)}</code>
      </div>
      <p className="provider-setup-auth">{t(guide.authKey)}</p>
      <button
        type="button"
        className="provider-setup-docs"
        onClick={() => void invoke("open_external_url", { url: guide.url }).catch(() => undefined)}
      >
        {t("查看安装与配置说明")}
        <ArrowUpRight size={13} aria-hidden="true" />
      </button>
    </aside>
  );
}
