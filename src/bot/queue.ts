import type { Api, InlineKeyboard, RawApi } from "grammy";
import { InputFile } from "grammy";

interface Job {
  chatId: number;
  caption: string;
  keyboard: InlineKeyboard;
  gifUrl: string | null;
  chartPng: Buffer | null;
}

const queues = new Map<number, Job[]>();
const busy = new Set<number>();

export function enqueueAlert(api: Api<RawApi>, job: Job): void {
  const list = queues.get(job.chatId) ?? [];
  list.push(job);
  queues.set(job.chatId, list);
  void drain(api, job.chatId);
}

async function drain(api: Api<RawApi>, chatId: number): Promise<void> {
  if (busy.has(chatId)) return;
  busy.add(chatId);
  try {
    while (true) {
      const list = queues.get(chatId);
      const job = list?.shift();
      if (!job) break;
      await send(api, job);
      await pause(350);
    }
  } finally {
    busy.delete(chatId);
  }
}

async function send(api: Api<RawApi>, job: Job): Promise<void> {
  const extra = {
    parse_mode: "HTML" as const,
    reply_markup: job.keyboard,
    link_preview_options: { is_disabled: true },
  };

  try {
    if (job.gifUrl) {
      await api.sendAnimation(job.chatId, job.gifUrl, { caption: job.caption, ...extra });
      return;
    }
  } catch (error) {
    console.warn("GIF send failed, falling back:", error);
  }

  try {
    if (job.chartPng) {
      await api.sendPhoto(job.chatId, new InputFile(job.chartPng, "chart.png"), {
        caption: job.caption,
        ...extra,
      });
      return;
    }
  } catch (error) {
    console.warn("Chart send failed, falling back:", error);
  }

  await api.sendMessage(job.chatId, job.caption, extra);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
