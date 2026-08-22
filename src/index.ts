import { Bot } from "grammy";
import { BOT_NAME, SLAY_ATH_USD, SLAY_TOKEN, assertConfig, config } from "./config.ts";
import { openDb, bumpAthForAddress } from "./store/db.ts";
import { registerAdmin } from "./bot/admin.ts";
import { registerChartCommand } from "./bot/chart-cmd.ts";
import { attachDispatcher } from "./bot/dispatch.ts";
import { registerSlides } from "./bot/slides.ts";
import { createProvider, EkuboListener } from "./indexer/listener.ts";

async function main(): Promise<void> {
  assertConfig();
  openDb();
  bumpAthForAddress(SLAY_TOKEN, SLAY_ATH_USD);
  const provider = createProvider();
  const bot = new Bot(config.telegramToken);

  registerAdmin(bot, provider);
  registerChartCommand(bot);
  registerSlides(bot);
  const onSwap = attachDispatcher(bot);
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
