import type { Api, RawApi } from "grammy";
import { InputFile } from "grammy";
import { alertKeyboard, type AlertLinks } from "./format.ts";
import { newSlideId, putSlide, rememberSentMedia, slideKeyboard } from "./slides.ts";

interface Job {
  chatId: number;
  caption: string;
  links: AlertLinks;
  gifUrl: string | null;
  chartPng: Buffer | null;
}

const queues = new Map<number, Job[]>();
const busy = new Set<number>();

const html = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };

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
  const hasGif = Boolean(job.gifUrl);
  const hasChart = Boolean(job.chartPng);

  if (hasGif && hasChart && job.gifUrl && job.chartPng) {
    const id = newSlideId();
    putSlide(id, {
      chatId: job.chatId,
      gifSource: job.gifUrl,
      gifFileId: null,
      chartPng: job.chartPng,
      chartFileId: null,
      showing: "gif",
      caption: job.caption,
      links: job.links,
    });
    try {
      const msg = await api.sendAnimation(job.chatId, job.gifUrl, {
        caption: job.caption,
        ...html,
        reply_markup: slideKeyboard(
          {
            chatId: job.chatId,
            gifSource: job.gifUrl,
            gifFileId: null,
            chartPng: job.chartPng,
            chartFileId: null,
            showing: "gif",
            caption: job.caption,
            links: job.links,
          },
          id,
        ),
      });
      rememberSentMedia(id, msg);
      return;
    } catch (error) {
      console.warn("GIF send failed, showing chart:", error);
    }
  }

  if (hasChart && job.chartPng) {
    try {
      await api.sendPhoto(job.chatId, new InputFile(job.chartPng, "chart.png"), {
        caption: job.caption,
        ...html,
        reply_markup: alertKeyboard(job.links),
      });
      return;
    } catch (error) {
      console.warn("Chart send failed, falling back:", error);
    }
  }

  if (hasGif && job.gifUrl) {
    try {
      await api.sendAnimation(job.chatId, job.gifUrl, {
        caption: job.caption,
        ...html,
        reply_markup: alertKeyboard(job.links),
      });
      return;
    } catch (error) {
      console.warn("GIF send failed, falling back:", error);
    }
  }

  await api.sendMessage(job.chatId, job.caption, {
    ...html,
    reply_markup: alertKeyboard(job.links),
  });
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
