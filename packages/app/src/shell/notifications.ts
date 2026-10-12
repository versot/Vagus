import { invoke } from "@tauri-apps/api/core";
import { type AppSettings } from "../features/settings/app-settings.js";
import { host } from "../lib/workspace-host.js";

export async function notifyTask(title: string, body: string) {
  try {
    const settings = await invoke<AppSettings>("get_app_settings");
    if (!settings.taskNotifications) return;
    await invoke("show_task_notification", { title, body });
    if (settings.notificationSound) {
      const audio = new AudioContext();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 740;
      gain.gain.setValueAtTime(0.0001, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.055, audio.currentTime + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.22);
      oscillator.connect(gain); gain.connect(audio.destination);
      oscillator.start(); oscillator.stop(audio.currentTime + 0.23);
      window.setTimeout(() => void audio.close(), 350);
    }
  } catch (error) { console.warn("Could not show Vagus task notification", error); }
}

export function fitNotificationText(value: string, maxUnits: number) {
  const compact = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  let result = "";
  let units = 0;
  for (const character of Array.from(compact)) {
    const wide = /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(character) || /\p{Extended_Pictographic}/u.test(character);
    const cost = wide ? 2 : 1;
    if (units + cost > maxUnits) return `${result.trimEnd()}…`;
    result += character;
    units += cost;
  }
  return result;
}

export async function notifySessionTask(sessionId: string, fallbackTitle: string) {
  let title = fallbackTitle;
  let latestReply = "";
  try {
    const session = await host.request("sessions.open", { sessionId, historyLimit: 120 }, 10_000);
    title = session.title || title;
    const latestAssistantEntry = [...(session.timeline ?? [])].reverse().find((entry) => entry.kind === "message" && entry.role === "assistant" && entry.complete);
    latestReply = latestAssistantEntry?.kind === "message" ? latestAssistantEntry.text : "";
  } catch (error) {
    console.warn("Could not load the latest reply for Vagus task notification", error);
  }
  await notifyTask(fitNotificationText(title, 54), fitNotificationText(latestReply || title, 132));
}
