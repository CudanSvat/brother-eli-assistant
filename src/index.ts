import { Bot } from "grammy";
import { BOT_NAME, assertConfig, config } from "./config.ts";
import { openDb } from "./store/db.ts";
import { registerAdmin } from "./bot/admin.ts";
import { attachDispatcher } from "./bot/dispatch.ts";
import { createProvider, EkuboListener } from "./indexer/listener.ts";

async function main(): Promise<void> {
  assertConfig();
  openDb();
  const provider = createProvider();
  const bot = new Bot(config.telegramToken);

  registerAdmin(bot, provider);
  const onSwap = attachDispatcher(bot, provider);
  const listener = new EkuboListener(provider, onSwap);

  bot.catch((err) => {
    console.error("Bot error:", err.error);
  });

  await listener.start();
  await bot.start({
    onStart: (info) => {
      console.log(`${BOT_NAME} @${info.username} is online`);
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
