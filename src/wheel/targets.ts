import type { Api } from "grammy";
import { config } from "../config.ts";
import { deleteGroup, listGroups } from "../store/db.ts";

/**
 * Chats that should receive Eli Selects.
 * While WHEEL_TEST_CHAT_ID is set (test bot), only that chat.
 * Later: every stored group where the bot is still administrator.
 */
export async function resolveWheelTargetChatIds(api: Api, botUserId: number): Promise<number[]> {
  if (config.wheelTestChatId != null) {
    return [config.wheelTestChatId];
  }

  const out: number[] = [];
  for (const group of listGroups()) {
    try {
      const member = await api.getChatMember(group.chatId, botUserId);
      if (member.status === "left" || member.status === "kicked") {
        deleteGroup(group.chatId);
        continue;
      }
      if (member.status === "administrator" || member.status === "creator") {
        out.push(group.chatId);
      }
    } catch {
      deleteGroup(group.chatId);
    }
  }
  return out;
}
