// Create a disposable legacy workspace for UI profiling. The caller should pass
// a temporary profile root; this never reads or writes the normal Vagus data.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: node scripts/create-synthetic-conversation.mjs <temporary-profile-root>");
const projectRoot = join(root, "synthetic-project");
const dataDir = join(root, ".vagus");
await mkdir(projectRoot, { recursive: true });
await mkdir(dataDir, { recursive: true });

const now = Date.now();
const createdAt = new Date(now - 90 * 24 * 60 * 60_000).toISOString();
const project = { id: "synthetic-project", name: "Synthetic performance sample", root: projectRoot, createdAt };
const messages = [];
const timeline = [];
const topics = ["workspace tabs", "long conversation rendering", "browser toolbar", "file system view", "keyboard shortcuts", "responsive layout", "React profiling", "SQLite history paging"];
let sequence = 0;
for (let turn = 0; turn < 1_200; turn++) {
  const occurredAt = new Date(now - (1_200 - turn) * 60_000).toISOString();
  const turnId = `synthetic-turn-${turn + 1}`;
  const topic = topics[turn % topics.length];
  const userText = `第 ${turn + 1} 轮：请继续检查 ${topic} 的体验，并说明这一项如何影响长会话。`;
  const user = { kind: "message", id: `synthetic-user-${turn + 1}`, sequence: ++sequence, turnId, occurredAt, role: "user", text: userText, complete: true };
  messages.push(user);
  timeline.push(user);

  const tool = { kind: "tool", id: `synthetic-tool-${turn + 1}`, sequence: ++sequence, turnId, occurredAt: new Date(Date.parse(occurredAt) + 1_000).toISOString(), name: turn % 3 === 0 ? "read" : "search", state: "done", input: { path: `src/${topic.replaceAll(" ", "-")}.tsx` }, output: `本地合成结果：${topic}，未访问网络。` };
  timeline.push(tool);

  const detail = turn % 6 === 0
    ? `\n\n| 检查项 | 观察 |\n| --- | --- |\n| 输入 | 有界更新 |\n| 历史 | 分页加载 |\n| 页面 | 保持响应 |\n\n~~~ts\nconst pageSize = 120;\nconst hasMore = beforeSequence !== null;\n~~~`
    : "";
  const assistantText = `第 ${turn + 1} 轮完成。围绕 **${topic}**，继续使用窗口化历史、稳定的列表 key 和局部状态更新。这个回答是本地生成的性能样本，不包含真实用户资料。${detail}`;
  const assistant = { kind: "message", id: `synthetic-assistant-${turn + 1}`, sequence: ++sequence, turnId, occurredAt: new Date(Date.parse(occurredAt) + 2_000).toISOString(), completedAt: new Date(Date.parse(occurredAt) + 3_000).toISOString(), role: "assistant", text: assistantText, complete: true };
  messages.push(assistant);
  timeline.push(assistant);
}

const session = {
  id: "synthetic-long-conversation",
  projectId: project.id,
  title: "合成性能样本 · 1,200 轮",
  createdAt,
  updatedAt: new Date(now).toISOString(),
  lastAssistantAt: new Date(now).toISOString(),
  lastUserAt: timeline.at(-2).occurredAt,
  hasAssistantReply: true,
  titleManuallySet: true,
  state: "ended",
  messages,
  timeline,
  eventSequence: sequence,
  providerId: "pi",
};
await writeFile(join(dataDir, "workspace.json"), JSON.stringify({ projects: [project], sessions: [session] }));
console.log(JSON.stringify({ dataDir, projectRoot, sessionId: session.id, turns: 1_200, messages: messages.length, timelineEntries: timeline.length }, null, 2));
