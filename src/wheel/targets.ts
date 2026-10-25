import type { Api } from "grammy";
import { config } from "../config.ts";
import { deleteGroup, listGroups } from "../store/db.ts";

/** True if the bot can post messages (and ideally media) in this chat. */
async function botCanPost(
  api: Api,
  chatId: number,
  botUserId: number,
): Promise<boolean> {
  try {
    const member = await api.getChatMember(chatId, botUserId);
    if (member.status === "left" || member.status === "kicked") {
      deleteGroup(chatId);
      return false;
    }
    if (member.status === "administrator" || member.status === "creator") {
      return true;
    }
    if (member.status === "restricted") {
      return Boolean(member.can_send_messages && member.can_send_other_messages);
    }
    if (member.status === "member") {
      const chat = await api.getChat(chatId);
      if (chat.type === "private") return false;
      const perms = "permissions" in chat ? chat.permissions : undefined;
      if (perms?.can_send_messages === false) return false;
      if (perms?.can_send_other_messages === false) return false;
      return true;
    }
    return false;
  } catch {
    deleteGroup(chatId);
    return false;
  }
}

/**
 * Chats that should receive Eli Selects.
 * Optional WHEEL_TEST_CHAT_ID limits to one chat (legacy test).
 * Otherwise: every known group where the bot can write.
 */
export async function resolveWheelTargetChatIds(
  api: Api,
  botUserId: number,
): Promise<number[]> {
  if (config.wheelTestChatId != null) {
    return [config.wheelTestChatId];
  }

  const out: number[] = [];
  for (const group of listGroups()) {
    if (await botCanPost(api, group.chatId, botUserId)) {
      out.push(group.chatId);
    }
  }
  return out;
}
