import type {
  AgentProvider,
  AgentSession,
  ImportedProviderSession,
  SessionStorageReference,
  StartSessionOptions,
} from "@vagus/agent-core";
import type { AgentEvent, ProviderImportCandidate, ProviderModelCatalog, ProviderModelInfo } from "@vagus/protocol";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { providerEnvironmentWithSearchPath } from "../../provider-environment.js";
import { resolveProviderExecutable } from "../../provider-executable.js";
import { discoverPiSessionFiles, piConversation } from "./history.js";
import { readPiExtensions } from "./pi-extension-catalog.js";
import { installPiPackage } from "./pi-package-install.js";
import { PiRpcProcess } from "./pi-rpc-process.js";
import { PiSession } from "./pi-session.js";
import { thinkingLevelsForModel } from "./settings.js";
import { PI_TUI_WIDGET_BRIDGE_SOURCE } from "./tui-bridge.js";
import { type RpcRecord } from "./types.js";
import { isRecord, stringField } from "./utils.js";

export interface PiProviderOptions {
  command?: string;
  noSession?: boolean;
}

export class PiProvider implements AgentProvider {
  private readonly importSources = new Map<string, string>();
  readonly descriptor = {
    id: "pi",
    displayName: "Pi",
    capabilities: [
      { id: "message.attachments", status: "implemented" as const, note: "可发送图片附件" },
      { id: "session.import", status: "implemented" as const, note: "可读取并导入本机 Pi JSONL 历史会话" },
      { id: "session.local", status: "partial" as const, note: "Desktop end-to-end flow pending" },
      {
        id: "session.queue",
        status: "partial" as const,
        note: "运行中转向、后续排队与队列清理已映射；恢复行为待桌面端验证",
      },
      {
        id: "session.context",
        status: "partial" as const,
        note: "手动/自动上下文整理已接入；长会话恢复与压缩结果验证待完成",
      },
      { id: "session.fork", status: "implemented" as const, note: "可从已完成的助手回复创建独立分支会话" },
      {
        id: "session.retry",
        status: "partial" as const,
        note: "Pi 自动重试状态会显示；停止操作会同时取消重试与当前运行",
      },
      {
        id: "session.commands",
        status: "partial" as const,
        note: "可发现并补全 Pi 扩展、提示模板和技能命令；Pi 内建 TUI 命令不属于 RPC 可执行命令",
      },
      { id: "interaction.dialog", status: "partial" as const, note: "标准问答与超时 UI 已接入，完整恢复链路待验证" },
      {
        id: "ui.extension",
        status: "partial" as const,
        note: "支持 RPC 文本 UI、setWidget TUI 快照及 custom TUI 组件的基础键盘/鼠标交互；完整终端特性仍不支持",
      },
    ],
  };

  constructor(private readonly options: PiProviderOptions = {}) {}

  private async resolveExecutable() {
    const environment = { ...process.env, ...(this.options.command ? { VAGUS_PI_COMMAND: this.options.command } : {}) };
    return resolveProviderExecutable({
      displayName: "Pi",
      commandNames: ["pi"],
      environmentVariables: ["VAGUS_PI_COMMAND"],
      environment,
    });
  }

  async listExtensions() {
    const executable = await this.resolveExecutable();
    return readPiExtensions(executable.path);
  }

  async installPackage(source: string) {
    return installPiPackage(this.options.command ?? process.env.VAGUS_PI_COMMAND ?? "pi", source);
  }

  async listImportableSessions(): Promise<ProviderImportCandidate[]> {
    const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const sessionsDirectory = join(agentDirectory, "sessions");
    let files: string[];
    try {
      files = await discoverPiSessionFiles(sessionsDirectory);
    } catch (error) {
      throw new Error(`无法读取 Pi 会话目录：${error instanceof Error ? error.message : String(error)}`);
    }
    const candidates: ProviderImportCandidate[] = [];
    this.importSources.clear();
    for (const path of files) {
      try {
        const info = await stat(path);
        if (info.size <= 0 || info.size > 128 * 1024 * 1024) continue;
        const raw = await readFile(path, "utf8");
        const records = raw.split(/\r?\n/u).flatMap((line) => {
          if (!line.trim()) return [];
          try {
            const parsed: unknown = JSON.parse(line);
            return isRecord(parsed) ? [parsed] : [];
          } catch {
            return [];
          }
        });
        const header = records.find((record) => record.type === "session");
        if (!header || typeof header.id !== "string" || typeof header.cwd !== "string" || !isAbsolute(header.cwd))
          continue;
        const id = header.id;
        this.importSources.set(id, path);
        const metadata = piConversation(records, basename(path, ".jsonl"));
        candidates.push({
          sourceId: id,
          providerId: "pi",
          title: metadata.title,
          workingDirectory: header.cwd,
          createdAt: metadata.createdAt,
          updatedAt: metadata.updatedAt,
          messageCount: metadata.messageCount,
          preview: metadata.preview,
        });
      } catch {
        // Ignore partial, inaccessible, and non-session JSONL files; Pi may still be writing one.
      }
    }
    return candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async importSession(sourceId: string): Promise<ImportedProviderSession> {
    const path = this.importSources.get(sourceId);
    if (!path) throw new Error("Pi 会话列表已过期，请重新扫描后再导入");
    const raw = await readFile(path, "utf8");
    const records = raw.split(/\r?\n/u).flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const parsed: unknown = JSON.parse(line);
        return isRecord(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
    const header = records.find((record) => record.type === "session");
    if (!header || typeof header.id !== "string" || typeof header.cwd !== "string" || !isAbsolute(header.cwd))
      throw new Error("Pi 原生会话文件无效或尚未写入完成");
    const metadata = piConversation(records, basename(path, ".jsonl"));
    const candidate: ProviderImportCandidate = {
      sourceId,
      providerId: "pi",
      title: metadata.title,
      workingDirectory: header.cwd,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      messageCount: metadata.messageCount,
      preview: metadata.preview,
    };
    return { candidate, storageReference: { sessionFile: path }, timeline: metadata.timeline };
  }

  isImportSourceImported(sourceId: string, references: readonly SessionStorageReference[]): boolean {
    const sourcePath = this.importSources.get(sourceId);
    if (!sourcePath) return false;
    const normalizePath = (path: string) =>
      resolve(path)
        .replace(/[\\/]+$/, "")
        .toLocaleLowerCase();
    const normalizedSourcePath = normalizePath(sourcePath);
    return references.some(
      (reference) =>
        typeof reference.sessionFile === "string" && normalizePath(reference.sessionFile) === normalizedSourcePath,
    );
  }

  async listModels(): Promise<ProviderModelCatalog> {
    const executable = await this.resolveExecutable();
    const rpc = new PiRpcProcess({
      command: executable.path,
      cwd: homedir(),
      args: ["--no-session"],
      environment: await providerEnvironmentWithSearchPath(),
    });
    try {
      const [nativeState, nativeCatalog] = await Promise.all([
        rpc.request("get_state"),
        rpc.request("get_available_models"),
      ]);
      if (!isRecord(nativeCatalog) || !Array.isArray(nativeCatalog.models)) {
        throw new Error("Pi 没有返回有效的模型目录");
      }

      const models: ProviderModelInfo[] = [];
      const seen = new Set<string>();
      for (const value of nativeCatalog.models) {
        if (!isRecord(value)) continue;
        const source = stringField(value, "provider");
        const nativeId = stringField(value, "id");
        if (!source || !nativeId) continue;
        const id = `${source}/${nativeId}`;
        if (seen.has(id)) continue;
        seen.add(id);
        models.push({
          id,
          name: stringField(value, "name") ?? nativeId,
          source,
          thinkingLevels: thinkingLevelsForModel(value),
        });
      }

      const nativeModel = isRecord(nativeState) && isRecord(nativeState.model) ? nativeState.model : null;
      const currentSource = nativeModel ? stringField(nativeModel, "provider") : undefined;
      const currentNativeId = nativeModel ? stringField(nativeModel, "id") : undefined;
      const currentModelId = currentSource && currentNativeId ? `${currentSource}/${currentNativeId}` : null;
      const currentThinkingLevel = isRecord(nativeState) ? (stringField(nativeState, "thinkingLevel") ?? null) : null;

      return {
        providerId: this.descriptor.id,
        models,
        currentModelId,
        currentThinkingLevel,
        fetchedAt: new Date().toISOString(),
        status: "ready",
        stale: false,
        executablePath: executable.path,
        executableSource: executable.source,
      };
    } finally {
      await rpc.close();
    }
  }

  async startSession(options: StartSessionOptions, emit: (event: AgentEvent) => void): Promise<AgentSession> {
    const sessionId = options.sessionId ?? randomUUID();
    try {
      if (!(await stat(options.workingDirectory)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Error(
        `Pi 工作目录不存在或无法访问：${options.workingDirectory}。请检查项目文件夹是否已移动、删除或断开，并在项目设置中更新目录。`,
      );
    }
    emit({ type: "session.state", sessionId, state: "starting" });
    const bridgeDirectory = await mkdtemp(join(tmpdir(), "vagus-pi-tui-"));
    const bridgePath = join(bridgeDirectory, "widget-bridge.mjs");
    // Windows may keep the extension file locked briefly after the child exits.
    // Cleanup is best-effort and must never become an unhandled rejection that
    // takes down the Host while it is already recovering from a Pi process exit.
    const cleanupBridge = async () => {
      try {
        await rm(bridgeDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // The OS will reclaim the short-lived temp directory; preserve Host availability.
      }
    };
    await writeFile(bridgePath, PI_TUI_WIDGET_BRIDGE_SOURCE, "utf8");
    const executable = await this.resolveExecutable();
    const rpc = new PiRpcProcess({
      command: executable.path,
      cwd: options.workingDirectory,
      environment: await providerEnvironmentWithSearchPath(),
      args: [
        "--extension",
        bridgePath,
        ...(options.resumeReference?.sessionFile
          ? ["--session", options.resumeReference.sessionFile]
          : this.options.noSession
            ? ["--no-session"]
            : []),
      ],
    });
    const startupRecords: RpcRecord[] = [];
    const stopBuffering = rpc.onEvent((record) => startupRecords.push({ ...record, vagusReceivedAt: Date.now() }));
    try {
      const state = await rpc.request("get_state");
      const sessionFile = isRecord(state) ? stringField(state, "sessionFile") : undefined;
      if (!this.options.noSession && !sessionFile) {
        throw new Error("Pi 没有返回原生会话文件位置，无法安全管理这条会话");
      }
      stopBuffering();
      const session = new PiSession(
        sessionId,
        rpc,
        emit,
        state,
        sessionFile ? { sessionFile } : undefined,
        startupRecords,
        cleanupBridge,
      );
      emit({ type: "session.state", sessionId, state: "idle" });
      return session;
    } catch (error) {
      stopBuffering();
      await rpc.close();
      await cleanupBridge();
      throw error;
    }
  }

  async deleteSession(reference: SessionStorageReference): Promise<void> {
    const sessionFile = reference.sessionFile;
    if (!sessionFile || !isAbsolute(sessionFile) || extname(sessionFile).toLowerCase() !== ".jsonl") {
      throw new Error("Pi 原生会话文件位置无效，未删除任何文件");
    }

    const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const sessionsDirectory = resolve(agentDirectory, "sessions");
    const candidate = resolve(sessionFile);
    let realSessionsDirectory: string;
    let realSessionFile: string;
    try {
      [realSessionsDirectory, realSessionFile] = await Promise.all([realpath(sessionsDirectory), realpath(candidate)]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const realRelative = relative(realSessionsDirectory, realSessionFile);
    if (!realRelative || realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
      throw new Error("Pi 原生会话文件解析到了 sessions 目录之外，未删除任何文件");
    }
    await unlink(realSessionFile);
  }
}
