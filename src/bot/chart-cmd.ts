import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { renderChartPng } from "../chart/render.ts";
import { formatTokenPrice } from "../lib/format.ts";
import {
  CHART_WINDOWS,
  DEFAULT_CHART_WINDOW,
  chartWindowLabel,
  geckoChartUrlForToken,
  getMarketSnapshot,
  getOhlcvForWindow,
  isChartWindow,
  resolveChartPair,
  type ChartWindow,
} from "../market/geckoterminal.ts";
import { config } from "../config.ts";
import { getDmSession, getToken, listTokens } from "../store/db.ts";
import type { TokenSettings } from "../types.ts";

function resolveGroupId(ctx: Context): number | null {
  if (!ctx.chat) return null;
  if (ctx.chat.type !== "private") return ctx.chat.id;
  if (!ctx.from) return null;
  return getDmSession(ctx.from.id);
}

function canUseToken(ctx: Context, token: TokenSettings): boolean {
  if (!ctx.chat) return false;
  if (ctx.chat.type === "private") {
    return Boolean(ctx.from && getDmSession(ctx.from.id) === token.chatId);
  }
  return token.chatId === ctx.chat.id;
}

function pickToken(tokens: TokenSettings[], query?: string): TokenSettings | null {
  if (!tokens.length) return null;
  if (!query) return tokens.length === 1 ? tokens[0]! : null;
  const q = query.trim().toLowerCase();
  return (
    tokens.find((t) => t.symbol.toLowerCase() === q) ??
    tokens.find((t) => t.symbol.toLowerCase().startsWith(q)) ??
    tokens.find((t) => t.address.toLowerCase().includes(q.replace(/^0x/, ""))) ??
    null
  );
}

function geckoChartLink(token: TokenSettings, market?: Awaited<ReturnType<typeof getMarketSnapshot>>): string {
  return geckoChartUrlForToken(token.address, market);
}

function chartKeyboard(tokenId: number, active: ChartWindow, geckoUrl: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  CHART_WINDOWS.forEach((window, i) => {
    const label = chartWindowLabel(window);
    const text = window === active ? `· ${label} ·` : label;
    kb.text(text, `ch:${tokenId}:${window}`);
    if (i === 2) kb.row();
  });
  kb.row().url("Gecko Chart", geckoUrl);
  return kb;
}

async function buildChart(
  token: TokenSettings,
  window: ChartWindow,
): Promise<{ png: Buffer; caption: string; geckoUrl: string } | null> {
  let market: Awaited<ReturnType<typeof getMarketSnapshot>> = null;
  try {
    market = await getMarketSnapshot(token.address);
  } catch {
    market = null;
  }
  const pair = resolveChartPair(token.address, market?.pairAddress ?? token.pairAddress);
  if (!pair) return null;

  const { candles, intervalLabel } = await getOhlcvForWindow(pair, window);

  const finish = (
    chartCandles: typeof candles,
    label: string,
  ) => {
    if (chartCandles.length < 2) return null;
    const png = renderChartPng(token.symbol, chartCandles, {
      quote: market?.quoteSymbol ?? "USD",
      intervalLabel: label,
      keepEmpty: true,
    });
    if (!png) return null;
    const price = market?.priceUsd ?? token.lastPriceUsd;
    const allNote = window === "all" && !config.coingeckoApiKey ? " · public API ~180d max" : "";
    return {
      png,
      caption: [
        `<b>${token.symbol}</b> · ${chartWindowLabel(window)} · ${label}${allNote}`,
        `Price: ${formatTokenPrice(price)}`,
      ].join("\n"),
      geckoUrl: geckoChartLink(token, market),
    };
  };

  return finish(candles, intervalLabel);
}

async function sendOrEditChart(
  ctx: Context,
  token: TokenSettings,
  window: ChartWindow,
  edit: boolean,
): Promise<void> {
  let built: { png: Buffer; caption: string; geckoUrl: string } | null = null;
  try {
    built = await buildChart(token, window);
  } catch (error) {
    console.warn("Chart build failed:", error);
  }

  if (!built) {
    if (ctx.callbackQuery) {
      // Keep the previous photo; only toast. Never leave the UI stuck.
      try {
        await ctx.answerCallbackQuery({
          text: `No ${chartWindowLabel(window)} data yet — wait a few seconds`,
          show_alert: false,
        });
      } catch {
        // callback may already be answered
      }
      return;
    }
    await ctx.reply(`No chart data for <b>${token.symbol}</b> yet. Try another window.`, {
      parse_mode: "HTML",
    });
    return;
  }

  const markup = chartKeyboard(token.id, window, built.geckoUrl);
  if (edit && ctx.callbackQuery?.message?.photo) {
    try {
      await ctx.editMessageMedia(
        {
          type: "photo",
          media: new InputFile(built.png, "chart.png"),
          caption: built.caption,
          parse_mode: "HTML",
        },
        { reply_markup: markup },
      );
      try {
        await ctx.answerCallbackQuery({ text: chartWindowLabel(window) });
      } catch {
        // already answered with loading
      }
      return;
    } catch (error) {
      console.warn("Chart edit failed:", error);
      try {
        await ctx.answerCallbackQuery({ text: "Could not refresh — try again" });
      } catch {
        // ignore
      }
      return;
    }
  }

  try {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
  } catch {
    // ignore
  }
  await ctx.replyWithPhoto(new InputFile(built.png, "chart.png"), {
    caption: built.caption,
    parse_mode: "HTML",
    reply_markup: markup,
  });
}

export function registerChartCommand(bot: Bot): void {
  bot.command("chart", async (ctx) => {
    if (!ctx.chat) return;
    const groupId = resolveGroupId(ctx);
    if (!groupId) {
      await ctx.reply(
        ctx.chat.type === "private"
          ? "Connect a group first (/start → paste group ID), then /chart."
          : "No group context.",
      );
      return;
    }

    const tokens = listTokens(groupId);
    if (!tokens.length) {
      await ctx.reply("No tokens tracked here yet. Use /start to add one.");
      return;
    }

    const arg = ctx.match?.trim() || "";
    const token = pickToken(tokens, arg || undefined);
    if (!token) {
      const kb = new InlineKeyboard();
      tokens.forEach((t, i) => {
        kb.text(t.symbol, `ch:${t.id}:${DEFAULT_CHART_WINDOW}`);
        if (i % 3 === 2) kb.row();
      });
      await ctx.reply("Which token?", { reply_markup: kb });
      return;
    }

    await sendOrEditChart(ctx, token, DEFAULT_CHART_WINDOW, false);
  });

  bot.callbackQuery(/^ch:(\d+):(1d|3d|7d|1m|all)$/, async (ctx) => {
    const tokenId = Number(ctx.match![1]);
    const windowRaw = ctx.match![2]!;
    if (!isChartWindow(windowRaw)) {
      await ctx.answerCallbackQuery({ text: "Unknown window" });
      return;
    }
    const token = getToken(tokenId);
    if (!token || !canUseToken(ctx, token)) {
      await ctx.answerCallbackQuery({ text: "Token not available here" });
      return;
    }

    try {
      await ctx.answerCallbackQuery({ text: `Loading ${chartWindowLabel(windowRaw)}…` });
    } catch {
      // ignore expired queries
    }

    const edit = Boolean(ctx.callbackQuery.message?.photo);
    await sendOrEditChart(ctx, token, windowRaw, edit);
  });
}
