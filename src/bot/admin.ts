import { Bot, type Context, InlineKeyboard } from "grammy";
import type { RpcProvider } from "starknet";
import { BOT_NAME, config } from "../config.ts";
import {
  clearDmSession,
  countTokens,
  deleteToken,
  getDmSession,
  getGroup,
  getToken,
  insertToken,
  listGroups,
  listTokens,
  setDmSession,
  updateToken,
  upsertGroup,
} from "../store/db.ts";
import { resolveToken } from "../market/tokens.ts";
import {
  adminHomeText,
  cancelKeyboard,
  connectGroupKeyboard,
  connectGroupText,
  homeKeyboard,
  tokenCardText,
  tokenKeyboard,
} from "./format.ts";
import type { PendingAction } from "../types.ts";

const pending = new Map<string, PendingAction>();

function pendingKey(userId: number, chatId: number): string {
  return `${userId}:${chatId}`;
}

function isPrivate(ctx: Context): boolean {
  return ctx.chat?.type === "private";
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

function parseGroupId(text: string): number | null {
  const raw = text.trim();
  const fromLink = raw.match(/(?:t\.me|telegram\.me)\/c\/(\d+)/i);
  if (fromLink) return Number(`-100${fromLink[1]}`);
  if (/^-100\d{5,}$/.test(raw)) return Number(raw);
  if (/^-\d{6,}$/.test(raw)) return Number(raw);
  if (/^\d{8,}$/.test(raw)) return Number(`-100${raw}`);
  return null;
}

function forwardedGroupId(ctx: Context): number | undefined {
  const msg = ctx.message;
  if (!msg) return undefined;
  const origin = msg.forward_origin;
  if (origin?.type === "channel") return origin.chat.id;
  if (origin?.type === "chat" && origin.sender_chat.type !== "private") return origin.sender_chat.id;
  const legacy = (msg as { forward_from_chat?: { id: number; type: string } }).forward_from_chat;
  if (legacy && legacy.type !== "private") return legacy.id;
  return undefined;
}

async function userIsGroupAdmin(ctx: Context, groupId: number): Promise<boolean> {
  if (!ctx.from) return false;
  try {
    const member = await ctx.api.getChatMember(groupId, ctx.from.id);
    return member.status === "creator" || member.status === "administrator";
  } catch {
    return false;
  }
}

async function targetGroupId(ctx: Context): Promise<number | null> {
  if (!ctx.chat || !ctx.from) return null;
  if (!isPrivate(ctx)) return ctx.chat.id;
  return getDmSession(ctx.from.id);
}

async function requireAdmin(ctx: Context): Promise<number | null> {
  const groupId = await targetGroupId(ctx);
  if (!groupId) return null;
  if (!(await userIsGroupAdmin(ctx, groupId))) {
    if (isPrivate(ctx) && ctx.from) clearDmSession(ctx.from.id);
    return null;
  }
  return groupId;
}

async function deny(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({
      text: isPrivate(ctx) ? "Connect a group first. You must be an admin." : "Admins only",
    });
    return;
  }
}

async function groupMeta(ctx: Context, groupId: number): Promise<{ title?: string | null; chatId: number }> {
  const stored = getGroup(groupId);
  if (stored?.title) return stored;
  try {
    const chat = await ctx.api.getChat(groupId);
    const title = "title" in chat ? chat.title : undefined;
    upsertGroup(groupId, title);
    return { chatId: groupId, title: title ?? stored?.title ?? null };
  } catch {
    return { chatId: groupId, title: stored?.title ?? null };
  }
}

async function showHome(ctx: Context, groupId: number, edit = false): Promise<void> {
  upsertGroup(groupId, ctx.chat && "title" in ctx.chat && ctx.chat.id === groupId ? ctx.chat.title : undefined);
  const tokens = listTokens(groupId);
  const meta = await groupMeta(ctx, groupId);
  const text = adminHomeText(tokens.length, meta);
  const markup = homeKeyboard(tokens, isPrivate(ctx));
  if (edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: markup });
      return;
    } catch {
      // fall through
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: markup });
}

async function showConnect(ctx: Context, edit = false): Promise<void> {
  if (ctx.from) {
    pending.set(pendingKey(ctx.from.id, ctx.chat!.id), { kind: "connect_group" });
  }
  const text = connectGroupText();
  const markup = connectGroupKeyboard(listGroups());
  if (edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: markup });
      return;
    } catch {
      // fall through
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: markup });
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
  const text = isPrivate(ctx)
    ? "Closed. Send /start to open the panel again, or paste a group ID to switch."
    : "Closed. Send /start anytime to open the panel again.";
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

async function connectToGroup(
  ctx: Context,
  groupId: number,
): Promise<{ ok: true; title?: string } | { ok: false; reason: string }> {
  if (!ctx.from) return { ok: false, reason: "Could not see who you are." };
  try {
    const botMember = await ctx.api.getChatMember(groupId, ctx.me.id);
    if (botMember.status === "left" || botMember.status === "kicked") {
      return { ok: false, reason: "I am not in that group. Add me as admin first (post + media)." };
    }
  } catch {
    return { ok: false, reason: "I am not in that group. Add me as admin first (post + media)." };
  }
  if (!(await userIsGroupAdmin(ctx, groupId))) {
    return { ok: false, reason: "You need to be a group admin to configure that chat." };
  }
  let title: string | undefined;
  try {
    const chat = await ctx.api.getChat(groupId);
    title = "title" in chat ? chat.title : undefined;
  } catch {
    // title optional
  }
  upsertGroup(groupId, title);
  setDmSession(ctx.from.id, groupId);
  return { ok: true, title };
}

async function tryConnect(ctx: Context, groupId: number, edit = false): Promise<boolean> {
  const result = await connectToGroup(ctx, groupId);
  if (!result.ok) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: result.reason });
    } else {
      await ctx.reply(result.reason, { reply_markup: connectGroupKeyboard(listGroups()) });
    }
    return false;
  }
  if (ctx.from && ctx.chat) pending.delete(pendingKey(ctx.from.id, ctx.chat.id));
  if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: result.title || "Connected" });
  await showHome(ctx, groupId, edit);
  return true;
}

export function registerAdmin(bot: Bot, provider: RpcProvider): void {
  bot.on("my_chat_member", async (ctx) => {
    const chat = ctx.chat;
    if (!chat || chat.type === "private") return;
    const status = ctx.myChatMember.new_chat_member.status;
    if (status === "member" || status === "administrator") {
      upsertGroup(chat.id, "title" in chat ? chat.title : undefined);
    }
  });

  bot.command(["start", "settings", "panel"], async (ctx) => {
    if (!ctx.chat || !ctx.from) return;
    clearPending(ctx);
    if (isPrivate(ctx)) {
      const saved = getDmSession(ctx.from.id);
      if (saved && (await userIsGroupAdmin(ctx, saved))) {
        await showHome(ctx, saved);
        return;
      }
      if (saved) clearDmSession(ctx.from.id);
      await showConnect(ctx);
      return;
    }
    if (!(await userIsGroupAdmin(ctx, ctx.chat.id))) {
      await ctx.reply(`Only group admins can configure ${BOT_NAME}. Alerts still post here automatically.`);
      return;
    }
    upsertGroup(ctx.chat.id, "title" in ctx.chat ? ctx.chat.title : undefined);
    await showHome(ctx, ctx.chat.id);
  });

  bot.command(["cancel", "close"], async (ctx) => {
    if (!ctx.chat || !ctx.from) return;
    if (isPrivate(ctx)) {
      clearPending(ctx);
      await showClosed(ctx, false);
      return;
    }
    if (!(await userIsGroupAdmin(ctx, ctx.chat.id))) return;
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
        "Admins: open /start in the group, or DM me and paste the group ID (starts with -100).",
        "You must be a group admin either way. Alerts still post in the group.",
        "Anyone: /chart for a live candlestick (tap 1d / 3d / 7d / 1M / All to refresh).",
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

  bot.callbackQuery("g:switch", async (ctx) => {
    if (!isPrivate(ctx) || !ctx.from) return deny(ctx);
    clearDmSession(ctx.from.id);
    clearPending(ctx);
    await ctx.answerCallbackQuery({ text: "Pick a group" });
    await showConnect(ctx, true);
  });

  bot.callbackQuery(/^g:open:(-?\d+)$/, async (ctx) => {
    if (!isPrivate(ctx)) return deny(ctx);
    const groupId = Number(ctx.match![1]);
    await tryConnect(ctx, groupId, true);
  });

  bot.callbackQuery("t:home", async (ctx) => {
    const groupId = await requireAdmin(ctx);
    if (!groupId) return deny(ctx);
    await showHome(ctx, groupId, true);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("t:help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      [
        "Paste a Starknet token address after tapping Add token. Send a GIF in this chat to set the buy animation — no URL needed.",
        "",
        "From DMs: paste the group ID (like <code>-1001861431308</code>) or forward a message from the group. Telegram Desktop group links look like t.me/c/<i>id</i>/…",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.callbackQuery("t:add", async (ctx) => {
    const groupId = await requireAdmin(ctx);
    if (!groupId) return deny(ctx);
    if (countTokens(groupId) >= config.maxTokensPerGroup) {
      await ctx.answerCallbackQuery({ text: `Cap is ${config.maxTokensPerGroup} tokens` });
      return;
    }
    pending.set(pendingKey(ctx.from!.id, ctx.chat!.id), { kind: "add_token", chatId: groupId });
    await ctx.answerCallbackQuery();
    await ask(ctx, "Send the Starknet token contract address.");
  });

  bot.callbackQuery(/^t:view:(\d+)$/, async (ctx) => {
    const groupId = await requireAdmin(ctx);
    if (!groupId) return deny(ctx);
    const token = getToken(Number(ctx.match![1]));
    if (!token || token.chatId !== groupId) {
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
    const groupId = await requireAdmin(ctx);
    if (!groupId) return deny(ctx);
    const current = getToken(Number(ctx.match![1]));
    if (!current || current.chatId !== groupId) return ctx.answerCallbackQuery({ text: "Token not found" });
    const token = updateToken(current.id, { chartEnabled: !current.chartEnabled });
    if (!token) return ctx.answerCallbackQuery();
    await ctx.editMessageText(tokenCardText(token), {
      parse_mode: "HTML",
      reply_markup: tokenKeyboard(token),
    });
    await ctx.answerCallbackQuery({ text: token.chartEnabled ? "Chart on" : "Chart off" });
  });

  bot.callbackQuery(/^t:min:(\d+)$/, async (ctx) => {
    const groupId = await requireAdmin(ctx);
    if (!groupId) return deny(ctx);
    pending.set(pendingKey(ctx.from!.id, ctx.chat!.id), {
      kind: "set_min",
      chatId: groupId,
      tokenId: Number(ctx.match![1]),
    });
    await ctx.answerCallbackQuery();
    await ask(ctx, "Send the smallest buy to post, in USD. Example: 5");
  });

  bot.callbackQuery(/^t:emoji:(\d+)$/, async (ctx) => {
    const groupId = await requireAdmin(ctx);
    if (!groupId) return deny(ctx);
    pending.set(pendingKey(ctx.from!.id, ctx.chat!.id), {
      kind: "set_emoji",
      chatId: groupId,
      tokenId: Number(ctx.match![1]),
    });
    await ctx.answerCallbackQuery();
    await ask(ctx, "Send one emoji for the buy ladder, e.g. 🟢");
  });

  bot.callbackQuery(/^t:step:(\d+)$/, async (ctx) => {
    const groupId = await requireAdmin(ctx);
    if (!groupId) return deny(ctx);
    pending.set(pendingKey(ctx.from!.id, ctx.chat!.id), {
      kind: "set_step",
      chatId: groupId,
      tokenId: Number(ctx.match![1]),
    });
    await ctx.answerCallbackQuery();
    await ask(ctx, "Send USD per emoji. Example: 50\nA $250 buy with a $50 step shows 5 emojis.");
  });

  bot.callbackQuery(/^t:gif:(\d+)$/, async (ctx) => {
    const groupId = await requireAdmin(ctx);
    if (!groupId) return deny(ctx);
    pending.set(pendingKey(ctx.from!.id, ctx.chat!.id), {
      kind: "set_gif",
      chatId: groupId,
      tokenId: Number(ctx.match![1]),
    });
    await ctx.answerCallbackQuery();
    await ask(ctx, "Send a GIF in this chat (or an mp4). You can also send a URL, or none to clear.");
  });

  bot.callbackQuery(/^t:wgif:(\d+)$/, async (ctx) => {
    const groupId = await requireAdmin(ctx);
    if (!groupId) return deny(ctx);
    pending.set(pendingKey(ctx.from!.id, ctx.chat!.id), {
      kind: "set_whale_gif",
      chatId: groupId,
      tokenId: Number(ctx.match![1]),
    });
    await ctx.answerCallbackQuery();
    await ask(
      ctx,
      "Send the whale GIF in this chat (or an mp4 / URL). Send none to clear.\nIt plays on buys at or above the whale USD size.",
    );
  });

  bot.callbackQuery(/^t:whale:(\d+)$/, async (ctx) => {
    const groupId = await requireAdmin(ctx);
    if (!groupId) return deny(ctx);
    pending.set(pendingKey(ctx.from!.id, ctx.chat!.id), {
      kind: "set_whale_usd",
      chatId: groupId,
      tokenId: Number(ctx.match![1]),
    });
    await ctx.answerCallbackQuery();
    await ask(
      ctx,
      "Send the whale size in USD. Buys at or above this amount get 🐋 and the whale GIF.\nExample: 500",
    );
  });

  bot.callbackQuery(/^t:price:(\d+)$/, async (ctx) => {
    const groupId = await requireAdmin(ctx);
    if (!groupId) return deny(ctx);
    pending.set(pendingKey(ctx.from!.id, ctx.chat!.id), {
      kind: "set_price_pct",
      chatId: groupId,
      tokenId: Number(ctx.match![1]),
    });
    await ctx.answerCallbackQuery();
    await ask(
      ctx,
      "Send a percent. If price moves that much since the last buy, the bot posts an extra ping.\nExample: 10 for ±10%. Send 0 to turn it off.",
    );
  });

  bot.callbackQuery(/^t:del:(\d+)$/, async (ctx) => {
    const groupId = await requireAdmin(ctx);
    if (!groupId) return deny(ctx);
    const id = Number(ctx.match![1]);
    const token = getToken(id);
    if (!token || token.chatId !== groupId) return ctx.answerCallbackQuery({ text: "Token not found" });
    const kb = new InlineKeyboard().text("Yes, remove", `t:delok:${id}`).text("Cancel", `t:view:${id}`);
    await ctx.editMessageText("Remove this token from the group?", { reply_markup: kb });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("t:close", async (ctx) => {
    const groupId = await requireAdmin(ctx);
    if (!groupId && !isPrivate(ctx)) return deny(ctx);
    clearPending(ctx);
    await ctx.answerCallbackQuery({ text: "Closed" });
    await showClosed(ctx, true);
  });

  bot.callbackQuery("t:cancel", async (ctx) => {
    const action = clearPending(ctx);
    if (action?.kind === "connect_group") {
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      await showConnect(ctx, true);
      return;
    }
    const groupId = await requireAdmin(ctx);
    if (!groupId) return deny(ctx);
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    try {
      await ctx.editMessageText("Cancelled.");
    } catch {
      // prompt may already be gone
    }
    if (action && "tokenId" in action) {
      const token = getToken(action.tokenId);
      if (token && token.chatId === groupId) {
        await ctx.reply(tokenCardText(token), {
          parse_mode: "HTML",
          reply_markup: tokenKeyboard(token),
        });
        return;
      }
    }
    await showHome(ctx, groupId);
  });

  bot.callbackQuery(/^t:delok:(\d+)$/, async (ctx) => {
    const groupId = await requireAdmin(ctx);
    if (!groupId) return deny(ctx);
    deleteToken(Number(ctx.match![1]), groupId);
    await showHome(ctx, groupId, true);
    await ctx.answerCallbackQuery({ text: "Removed" });
  });

  bot.on(["message:animation", "message:video", "message:document"], async (ctx, next) => {
    if (!ctx.from || !ctx.chat) return next();
    const action = pending.get(pendingKey(ctx.from.id, ctx.chat.id));
    if (!action || (action.kind !== "set_gif" && action.kind !== "set_whale_gif")) {
      return next();
    }
    if (!(await userIsGroupAdmin(ctx, action.chatId))) return next();
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
    const text = ctx.message.text.trim();

    if (action?.kind === "connect_group" || (isPrivate(ctx) && !action && (parseGroupId(text) || forwardedGroupId(ctx)))) {
      const groupId = parseGroupId(text) ?? forwardedGroupId(ctx);
      if (!groupId) {
        await ctx.reply(
          "Send a numeric group ID (starts with -100), or forward a message from the group.",
          { reply_markup: connectGroupKeyboard(listGroups()) },
        );
        return;
      }
      await tryConnect(ctx, groupId);
      return;
    }

    if (!action) return next();
    if (!(await userIsGroupAdmin(ctx, action.chatId))) return next();

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
      const nextToken = updateToken(token.id, { minUsd: value });
      await ctx.reply(tokenCardText(nextToken!), { parse_mode: "HTML", reply_markup: tokenKeyboard(nextToken!) });
      return;
    }

    if (action.kind === "set_emoji") {
      const nextToken = updateToken(token.id, { emoji: text.slice(0, 8) });
      await ctx.reply(tokenCardText(nextToken!), { parse_mode: "HTML", reply_markup: tokenKeyboard(nextToken!) });
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
      const nextToken = updateToken(token.id, { emojiStepUsd: value });
      await ctx.reply(tokenCardText(nextToken!), { parse_mode: "HTML", reply_markup: tokenKeyboard(nextToken!) });
      return;
    }

    if (action.kind === "set_whale_usd") {
      const value = Number(text.replace(/[$,]/g, ""));
      if (!Number.isFinite(value) || value <= 0) {
        pending.set(key, action);
        await ctx.reply("Send a USD amount, e.g. 500 — or tap Cancel.", { reply_markup: cancelKeyboard() });
        return;
      }
      const nextToken = updateToken(token.id, { whaleUsd: value });
      await ctx.reply(tokenCardText(nextToken!), { parse_mode: "HTML", reply_markup: tokenKeyboard(nextToken!) });
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
      const nextToken = updateToken(token.id, action.kind === "set_gif" ? { gifUrl: url } : { whaleGifUrl: url });
      await ctx.reply(tokenCardText(nextToken!), { parse_mode: "HTML", reply_markup: tokenKeyboard(nextToken!) });
      return;
    }

    if (action.kind === "set_price_pct") {
      const value = Number(text.replace(/%/g, ""));
      if (!Number.isFinite(value) || value < 0) {
        pending.set(key, action);
        await ctx.reply("Send a percent, e.g. 10 — or tap Cancel.", { reply_markup: cancelKeyboard() });
        return;
      }
      const nextToken = updateToken(token.id, { priceAlertPct: value === 0 ? null : value });
      await ctx.reply(tokenCardText(nextToken!), { parse_mode: "HTML", reply_markup: tokenKeyboard(nextToken!) });
    }
  });

  bot.on("message", async (ctx, next) => {
    if (!isPrivate(ctx) || !ctx.from || !ctx.chat) return next();
    if (ctx.message?.text) return next();
    const key = pendingKey(ctx.from.id, ctx.chat.id);
    const action = pending.get(key);
    if (action && action.kind !== "connect_group") return next();
    const groupId = forwardedGroupId(ctx);
    if (!groupId) return next();
    await tryConnect(ctx, groupId);
  });
}
