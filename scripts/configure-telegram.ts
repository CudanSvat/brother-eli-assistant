import "dotenv/config";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

async function api(method: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<{ ok: boolean; result?: unknown; description?: string }>;
}

async function main() {
  const me = await api("getMe", {});
  console.log("getMe", me.ok, me.result);
  const name = await api("setMyName", { name: "Brother Eli Assistant" });
  console.log("setMyName", name.ok, name.description ?? "");
  const desc = await api("setMyDescription", {
    description:
      "A Starknet helper for Telegram groups. Live buy alerts, charts, and GIFs now — more tools on the way.",
  });
  console.log("setMyDescription", desc.ok, desc.description ?? "");
  const short = await api("setMyShortDescription", {
    short_description: "Your Starknet helper in Telegram",
  });
  console.log("setMyShortDescription", short.ok, short.description ?? "");
  const cmds = await api("setMyCommands", {
    commands: [
      { command: "start", description: "Open the admin panel in a group" },
      { command: "settings", description: "Token settings" },
      { command: "help", description: "How Brother Eli Assistant works" },
    ],
  });
  console.log("setMyCommands", cmds.ok, cmds.description ?? "");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
