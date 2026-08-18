import { Bot, type Context, InlineKeyboard } from "grammy";
import type { RpcProvider } from "starknet";
import { BOT_NAME, config } from "../config.ts";
import {
  countTokens,
  deleteToken,
  getToken,
  insertToken,
  listTokens,
  updateToken,
  upsertGroup,
} from "../store/db.ts";
import { resolveToken } from "../market/tokens.ts";
import {
  adminHomeText,
  cancelKeyboard,
  homeKeyboard,
  tokenCardText,
  tokenKeyboard,
} from "./format.ts";
import type { PendingAction } from "../types.ts";

const pending = new Map<string, PendingAction>();

function pendingKey(userId: number, chatId: number): string {
  return `${userId}:${chatId}`;
}

function mediaFileId(ctx: Context): string | undefined {
  const msg = ctx.message;
  if (!msg) return undefined;
  if (msg.animation?.file_id) return msg.animation.file_id;
  if (msg.video?.file_id) return msg.video.file_id;
  const mime = msg.document?.mime_type ?? "";
  if (msg.document?.file_id && /gif|mp4|webm|quicktime/i.test(mime)) {
    return msg.document.file_id;
  }
  return undefined;
}

async function isGroupAdmin(ctx: Context): Promise<boolean> {
  if (!ctx.chat || !ctx.from) return false;
  if (ctx.chat.type === "private") return false;
  try {
    const member = await ctx.getChatMember(ctx.from.id);
    return ["creator", "administrator"].includes(member.status);
  } catch {
    return false;
  }
}

function home(ctx: Context) {
  const chatId = ctx.chat!.id;
  upsertGroup(chatId, ctx.chat && "title" in ctx.chat ? ctx.chat.title : undefined);
  const tokens = listTokens(chatId);
  return ctx.reply(adminHomeText(tokens.length), {
    parse_mode: "HTML",
    reply_markup: homeKeyboard(tokens),
  });
}

function clearPending(ctx: Context): PendingAction | undefined {
  if (!ctx.from || !ctx.chat) return undefined;
  const key = pendingKey(ctx.from.id, ctx.chat.id);
  const action = pending.get(key);
  pending.delete(key);
  return action;
}

async function ask(ctx: Context, text: string): Promise<void> {
  await ctx.reply(text, { reply_markup: cancelKeyboard() });
}

async function showClosed(ctx: Context, edit: boolean): Promise<void> {
  const text = "Closed. Send /start anytime to open the panel again.";
  if (edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text);
      return;
    } catch {
      // fall through to a new message
    }
  }
  await ctx.reply(text);
}

export function registerAdmin(bot: Bot, provider: RpcProvider): void {
  bot.command(["start", "settings", "panel"], async (ctx) => {
    if (!ctx.chat) return;
    if (ctx.chat.type === "private") {
      await ctx.reply(
        `<b>${BOT_NAME}</b> lives in groups.\nAdd me to a Starknet group, grant post + media rights, then send /start there.`,
        { parse_mode: "HTML" },
      );
      return;
    }
    if (!(await isGroupAdmin(ctx))) {
      await ctx.reply(`Only group admins can configure ${BOT_NAME}. Alerts still post here automatically.`);
      return;
    }
    clearPending(ctx);
    await home(ctx);
  });

  bot.command(["cancel", "close"], async (ctx) => {
    if (!ctx.chat || ctx.chat.type === "private") return;
    if (!(await isGroupAdmin(ctx))) return;
    clearPending(ctx);
    await showClosed(ctx, false);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        `<b>${BOT_NAME}</b> is a Starknet helper for Telegram groups.`,
        "",
        "Right now: live Ekubo buy alerts (price, chart, GIFs). More tools are coming.",
        "",
        "Admins: /start to add a token, then set min buy, emoji, GIF (send a GIF in chat), and chart.",
        "Tap Close or send /cancel to exit the panel. Members just watch the feed.",
        "",
        "<b>Step</b> = USD per emoji. $50 step and a $250 buy → 5 emojis.",
        "<b>Chart</b> = candlesticks on the buy card. If a GIF is set, tap Chart / GIF to switch.",
        "<b>Price ping</b> = extra message when the token price moves by that percent.",
        "",
        "AVNU/Fibrous can split one swap across several pools. Those hops are merged into a single buy.",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.callbackQuery("t:home", async (ctx) => {
    if (!(await isGroupAdmin(ctx))) return ctx.answerCallbackQuery({ text: "Admins only" });
    const tokens = listTokens(ctx.chat!.id);
    await ctx.editMessageText(adminHomeText(tokens.length), {
      parse_mode: "HTML",
      reply_markup: homeKeyboard(tokens),
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("t:help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Paste a Starknet token address after tapping Add token. Send a GIF in chat to set the buy animation — no URL needed.",
    );
  });

  bot.callbackQuery("t:add", async (ctx) => {
    if (!(await isGroupAdmin(ctx))) return ctx.answerCallbackQuery({ text: "Admins only" });
    if (countTokens(ctx.chat!.id) >= config.maxTokensPerGroup) {
      await ctx.answerCallbackQuery({ text: `Cap is ${config.maxTokensPerGroup} tokens` });
      return;
    }
    pending.set(pendingKey(ctx.from!.id, ctx.chat!.id), { kind: "add_token", chatId: ctx.chat!.id });
    await ctx.answerCallbackQuery();
    await ask(ctx, "Send the Starknet token contract address.");
  });

  bot.callbackQuery(/^t:view:(\d+)$/, async (ctx) => {
    if (!(await isGroupAdmin(ctx))) return ctx.answerCallbackQuery({ text: "Admins only" });
    const token = getToken(Number(ctx.match![1]));
    if (!token || token.chatId !== ctx.chat!.id) {
      await ctx.answerCallbackQuery({ text: "Token not found" });
      return;
    }
    await ctx.editMessageText(tokenCardText(token), {
      parse_mode: "HTML",
      reply_markup: tokenKeyboard(token),
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^t:chart:(\d+)$/, async (ctx) => {
    if (!(await isGroupAdmin(ctx))) return ctx.answerCallbackQuery({ text: "Admins only" });
    const token = updateToken(Number(ctx.match![1]), {
      chartEnabled: !getToken(Number(ctx.match![1]))?.chartEnabled,
    });
    if (!token) return ctx.answerCallbackQuery();
    await ctx.editMessageText(tokenCardText(token), {
      parse_mode: "HTML",
      reply_markup: tokenKeyboard(token),
    });
    await ctx.answerCallbackQuery({ text: token.chartEnabled ? "Chart on" : "Chart off" });
  });

  bot.callbackQuery(/^t:min:(\d+)$/, async (ctx) => {
    if (!(await isGroupAdmin(ctx))) return ctx.answerCallbackQuery({ text: "Admins only" });
    pending.set(pendingKey(ctx.from!.id, ctx.chat!.id), {
      kind: "set_min",
      chatId: ctx.chat!.id,
      tokenId: Number(ctx.match![1]),
    });
    await ctx.answerCallbackQuery();
    await ask(ctx, "Send the smallest buy to post, in USD. Example: 5");
  });

  bot.callbackQuery(/^t:emoji:(\d+)$/, async (ctx) => {
    if (!(await isGroupAdmin(ctx))) return ctx.answerCallbackQuery({ text: "Admins only" });
    pending.set(pendingKey(ctx.from!.id, ctx.chat!.id), {
      kind: "set_emoji",
      chatId: ctx.chat!.id,
      tokenId: Number(ctx.match![1]),
    });
    await ctx.answerCallbackQuery();
    await ask(ctx, "Send one emoji for the buy ladder, e.g. 🟢");
  });

  bot.callbackQuery(/^t:step:(\d+)$/, async (ctx) => {
    if (!(await isGroupAdmin(ctx))) return ctx.answerCallbackQuery({ text: "Admins only" });
    pending.set(pendingKey(ctx.from!.id, ctx.chat!.id), {
      kind: "set_step",
      chatId: ctx.chat!.id,
      tokenId: Number(ctx.match![1]),
    });
    await ctx.answerCallbackQuery();
    await ask(ctx, "Send USD per emoji. Example: 50\nA $250 buy with a $50 step shows 5 emojis.");
  });

  bot.callbackQuery(/^t:gif:(\d+)$/, async (ctx) => {
    if (!(await isGroupAdmin(ctx))) return ctx.answerCallbackQuery({ text: "Admins only" });
    pending.set(pendingKey(ctx.from!.id, ctx.chat!.id), {
      kind: "set_gif",
      chatId: ctx.chat!.id,
      tokenId: Number(ctx.match![1]),
    });
    await ctx.answerCallbackQuery();
    await ask(ctx, "Send a GIF in this chat (or an mp4). You can also send a URL, or none to clear.");
  });

  bot.callbackQuery(/^t:wgif:(\d+)$/, async (ctx) => {
    if (!(await isGroupAdmin(ctx))) return ctx.answerCallbackQuery({ text: "Admins only" });
    pending.set(pendingKey(ctx.from!.id, ctx.chat!.id), {
      kind: "set_whale_gif",
      chatId: ctx.chat!.id,
      tokenId: Number(ctx.match![1]),
    });
    await ctx.answerCallbackQuery();
    await ask(
      ctx,
      "Send the whale GIF in this chat (or an mp4 / URL). Send none to clear.\nIt plays on buys at or above the whale USD size.",
    );
  });

  bot.callbackQuery(/^t:whale:(\d+)$/, async (ctx) => {
    if (!(await isGroupAdmin(ctx))) return ctx.answerCallbackQuery({ text: "Admins only" });
    pending.set(pendingKey(ctx.from!.id, ctx.chat!.id), {
      kind: "set_whale_usd",
      chatId: ctx.chat!.id,
      tokenId: Number(ctx.match![1]),
    });
    await ctx.answerCallbackQuery();
    await ask(
      ctx,
      "Send the whale size in USD. Buys at or above this amount get 🐋 and the whale GIF.\nExample: 500",
    );
  });

  bot.callbackQuery(/^t:price:(\d+)$/, async (ctx) => {
    if (!(await isGroupAdmin(ctx))) return ctx.answerCallbackQuery({ text: "Admins only" });
    pending.set(pendingKey(ctx.from!.id, ctx.chat!.id), {
      kind: "set_price_pct",
      chatId: ctx.chat!.id,
      tokenId: Number(ctx.match![1]),
    });
    await ctx.answerCallbackQuery();
    await ask(
      ctx,
      "Send a percent. If price moves that much since the last buy, the bot posts an extra ping.\nExample: 10 for ±10%. Send 0 to turn it off.",
    );
  });

  bot.callbackQuery(/^t:del:(\d+)$/, async (ctx) => {
    if (!(await isGroupAdmin(ctx))) return ctx.answerCallbackQuery({ text: "Admins only" });
    const id = Number(ctx.match![1]);
    const kb = new InlineKeyboard()
      .text("Yes, remove", `t:delok:${id}`)
      .text("Cancel", `t:view:${id}`);
    await ctx.editMessageText("Remove this token from the group?", { reply_markup: kb });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("t:close", async (ctx) => {
    if (!(await isGroupAdmin(ctx))) return ctx.answerCallbackQuery({ text: "Admins only" });
    clearPending(ctx);
    await ctx.answerCallbackQuery({ text: "Closed" });
    await showClosed(ctx, true);
  });

  bot.callbackQuery("t:cancel", async (ctx) => {
    if (!(await isGroupAdmin(ctx))) return ctx.answerCallbackQuery({ text: "Admins only" });
    const action = clearPending(ctx);
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    try {
      await ctx.editMessageText("Cancelled.");
    } catch {
      // prompt may already be gone
    }
    if (action && "tokenId" in action) {
      const token = getToken(action.tokenId);
      if (token && token.chatId === ctx.chat!.id) {
        await ctx.reply(tokenCardText(token), {
          parse_mode: "HTML",
          reply_markup: tokenKeyboard(token),
        });
        return;
      }
    }
    await home(ctx);
  });

  bot.callbackQuery(/^t:delok:(\d+)$/, async (ctx) => {
    if (!(await isGroupAdmin(ctx))) return ctx.answerCallbackQuery({ text: "Admins only" });
    deleteToken(Number(ctx.match![1]), ctx.chat!.id);
    const tokens = listTokens(ctx.chat!.id);
    await ctx.editMessageText(adminHomeText(tokens.length), {
      parse_mode: "HTML",
      reply_markup: homeKeyboard(tokens),
    });
    await ctx.answerCallbackQuery({ text: "Removed" });
  });

  bot.on(["message:animation", "message:video", "message:document"], async (ctx, next) => {
    if (!ctx.from || !ctx.chat) return next();
    const action = pending.get(pendingKey(ctx.from.id, ctx.chat.id));
    if (!action || (action.kind !== "set_gif" && action.kind !== "set_whale_gif")) {
      return next();
    }
    if (!(await isGroupAdmin(ctx))) return next();
    const fileId = mediaFileId(ctx);
    if (!fileId) {
      await ctx.reply("Send a GIF or mp4, or none to clear — or tap Cancel.", {
        reply_markup: cancelKeyboard(),
      });
      return;
    }
    pending.delete(pendingKey(ctx.from.id, ctx.chat.id));
    const token = getToken(action.tokenId);
    if (!token || token.chatId !== action.chatId) {
      await ctx.reply("Token not found.");
      return;
    }
    const nextToken = updateToken(
      token.id,
      action.kind === "set_gif" ? { gifUrl: fileId } : { whaleGifUrl: fileId },
    );
    await ctx.reply(tokenCardText(nextToken!), {
      parse_mode: "HTML",
      reply_markup: tokenKeyboard(nextToken!),
    });
  });

  bot.on("message:text", async (ctx, next) => {
    if (!ctx.from || !ctx.chat) return next();
    if (ctx.message.text.startsWith("/")) return next();
    const key = pendingKey(ctx.from.id, ctx.chat.id);
    const action = pending.get(key);
    if (!action) return next();
    if (!(await isGroupAdmin(ctx))) return next();
    const text = ctx.message.text.trim();

    if (/^(cancel|close)$/i.test(text)) {
      pending.delete(key);
      await showClosed(ctx, false);
      return;
    }

    pending.delete(key);

    if (action.kind === "add_token") {
      await ctx.reply("Looking up token…");
      const resolved = await resolveToken(provider, text);
      if (!resolved) {
        pending.set(key, action);
        await ctx.reply("Could not resolve that address. Check the chain and try again, or tap Cancel.", {
          reply_markup: cancelKeyboard(),
        });
        return;
      }
      if (countTokens(action.chatId) >= config.maxTokensPerGroup) {
        await ctx.reply(`This group already tracks ${config.maxTokensPerGroup} tokens.`);
        return;
      }
      try {
        const token = insertToken({
          chatId: action.chatId,
          ...resolved,
        });
        await ctx.reply(
          `Token <b>${token.symbol}</b> added [${countTokens(action.chatId)}/${config.maxTokensPerGroup}]`,
          { parse_mode: "HTML", reply_markup: tokenKeyboard(token) },
        );
      } catch {
        await ctx.reply("That token is already tracked in this group.");
      }
      return;
    }

    const token = getToken(action.tokenId);
    if (!token || token.chatId !== action.chatId) {
      await ctx.reply("Token not found.");
      return;
    }

    if (action.kind === "set_min") {
      const value = Number(text.replace(/[$,]/g, ""));
      if (!Number.isFinite(value) || value < 0) {
        pending.set(key, action);
        await ctx.reply("Send a number, e.g. 100 — or tap Cancel.", { reply_markup: cancelKeyboard() });
        return;
      }
      const next = updateToken(token.id, { minUsd: value });
      await ctx.reply(tokenCardText(next!), { parse_mode: "HTML", reply_markup: tokenKeyboard(next!) });
      return;
    }

    if (action.kind === "set_emoji") {
      const next = updateToken(token.id, { emoji: text.slice(0, 8) });
      await ctx.reply(tokenCardText(next!), { parse_mode: "HTML", reply_markup: tokenKeyboard(next!) });
      return;
    }

    if (action.kind === "set_step") {
      const value = Number(text.replace(/[$,]/g, ""));
      if (!Number.isFinite(value) || value <= 0) {
        pending.set(key, action);
        await ctx.reply("Send a positive number, e.g. 50 — or tap Cancel.", {
          reply_markup: cancelKeyboard(),
        });
        return;
      }
      const next = updateToken(token.id, { emojiStepUsd: value });
      await ctx.reply(tokenCardText(next!), { parse_mode: "HTML", reply_markup: tokenKeyboard(next!) });
      return;
    }

    if (action.kind === "set_whale_usd") {
      const value = Number(text.replace(/[$,]/g, ""));
      if (!Number.isFinite(value) || value <= 0) {
        pending.set(key, action);
        await ctx.reply("Send a USD amount, e.g. 500 — or tap Cancel.", { reply_markup: cancelKeyboard() });
        return;
      }
      const next = updateToken(token.id, { whaleUsd: value });
      await ctx.reply(tokenCardText(next!), { parse_mode: "HTML", reply_markup: tokenKeyboard(next!) });
      return;
    }

    if (action.kind === "set_gif" || action.kind === "set_whale_gif") {
      const cleared = /^(none|off|clear|-)$/i.test(text);
      const url = cleared ? null : text;
      if (url && !/^https?:\/\//i.test(url)) {
        pending.set(key, action);
        await ctx.reply("Send a GIF in this chat, a URL, or none — or tap Cancel.", {
          reply_markup: cancelKeyboard(),
        });
        return;
      }
      const next = updateToken(token.id, action.kind === "set_gif" ? { gifUrl: url } : { whaleGifUrl: url });
      await ctx.reply(tokenCardText(next!), { parse_mode: "HTML", reply_markup: tokenKeyboard(next!) });
      return;
    }

    if (action.kind === "set_price_pct") {
      const value = Number(text.replace(/%/g, ""));
      if (!Number.isFinite(value) || value < 0) {
        pending.set(key, action);
        await ctx.reply("Send a percent, e.g. 10 — or tap Cancel.", { reply_markup: cancelKeyboard() });
        return;
      }
      const next = updateToken(token.id, { priceAlertPct: value === 0 ? null : value });
      await ctx.reply(tokenCardText(next!), { parse_mode: "HTML", reply_markup: tokenKeyboard(next!) });
    }
  });
}
