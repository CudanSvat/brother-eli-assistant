import { randomBytes } from "node:crypto";
import { Bot, InputFile, type Context } from "grammy";
import { alertKeyboard, type AlertLinks } from "./format.ts";

export interface Slide {
  chatId: number;
  gifSource: string;
  gifFileId: string | null;
  chartPng: Buffer | null;
  chartFileId: string | null;
  showing: "gif" | "chart";
  caption: string;
  links: AlertLinks;
}

const slides = new Map<string, Slide>();

export function newSlideId(): string {
  return randomBytes(4).toString("hex");
}

export function putSlide(id: string, slide: Slide): void {
  slides.set(id, slide);
  if (slides.size > 2_000) {
    const drop = [...slides.keys()].slice(0, slides.size - 1_200);
    for (const key of drop) slides.delete(key);
  }
}

export function slideKeyboard(slide: Slide, id: string) {
  return alertKeyboard(slide.links, {
    id,
    show: slide.showing === "gif" ? "chart" : "gif",
  });
}

function fileIdFromMessage(msg: {
  animation?: { file_id: string };
  photo?: Array<{ file_id: string }>;
}): { gif?: string; photo?: string } {
  if (msg.animation?.file_id) return { gif: msg.animation.file_id };
  const photos = msg.photo;
  if (photos?.length) return { photo: photos[photos.length - 1]!.file_id };
  return {};
}

export function rememberSentMedia(
  id: string,
  msg: { animation?: { file_id: string }; photo?: Array<{ file_id: string }> },
): void {
  const slide = slides.get(id);
  if (!slide) return;
  const ids = fileIdFromMessage(msg);
  if (ids.gif) slide.gifFileId = ids.gif;
  if (ids.photo) slide.chartFileId = ids.photo;
}

export function registerSlides(bot: Bot): void {
  bot.callbackQuery(/^s:([a-f0-9]{8}):([cg])$/, async (ctx) => {
    const id = ctx.match![1]!;
    const want = ctx.match![2] === "c" ? "chart" : "gif";
    const slide = slides.get(id);
    if (!slide || !ctx.chat || !ctx.callbackQuery.message) {
      await ctx.answerCallbackQuery({ text: "This slide expired. Wait for the next buy." });
      return;
    }
    if (slide.showing === want) {
      await ctx.answerCallbackQuery();
      return;
    }
    try {
      await switchSlide(ctx, id, slide, want);
      await ctx.answerCallbackQuery();
    } catch (error) {
      console.warn("Slide switch failed:", error);
      await ctx.answerCallbackQuery({ text: "Could not switch media" });
    }
  });
}

async function switchSlide(
  ctx: Context,
  id: string,
  slide: Slide,
  want: "gif" | "chart",
): Promise<void> {
    const extra = {
      reply_markup: alertKeyboard(slide.links, {
        id,
        show: want === "gif" ? "chart" : "gif",
      }),
    };

  if (want === "chart") {
    const media =
      slide.chartFileId ??
      (slide.chartPng ? new InputFile(slide.chartPng, "chart.png") : null);
    if (!media) throw new Error("no chart");
    const edited = await ctx.editMessageMedia(
      {
        type: "photo",
        media,
        caption: slide.caption,
        parse_mode: "HTML",
      },
      extra,
    );
    if (edited && typeof edited === "object") {
      const ids = fileIdFromMessage(edited);
      if (ids.photo) {
        slide.chartFileId = ids.photo;
        slide.chartPng = null;
      }
    }
    slide.showing = "chart";
    return;
  }

  const gif = slide.gifFileId ?? slide.gifSource;
  const edited = await ctx.editMessageMedia(
    {
      type: "animation",
      media: gif,
      caption: slide.caption,
      parse_mode: "HTML",
    },
    extra,
  );
  if (edited && typeof edited === "object") {
    const ids = fileIdFromMessage(edited);
    if (ids.gif) slide.gifFileId = ids.gif;
  }
  slide.showing = "gif";
}
