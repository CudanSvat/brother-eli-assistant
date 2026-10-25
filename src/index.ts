import { Bot } from "grammy";
import { BOT_NAME, SLAY_ATH_USD, SLAY_TOKEN, assertConfig, config } from "./config.ts";
import { openDb, bumpAthForAddress } from "./store/db.ts";
import { registerAdmin } from "./bot/admin.ts";
import { registerChartCommand } from "./bot/chart-cmd.ts";
import { registerEliCommand } from "./bot/eli-cmd.ts";
import { registerShillCommand } from "./bot/shill-cmd.ts";
import { registerWheelCommand } from "./bot/wheel-cmd.ts";
import { attachDispatcher } from "./bot/dispatch.ts";
import { attachNftDispatcher } from "./bot/nft-dispatch.ts";
import { attachBurnDispatcher } from "./bot/burn-dispatch.ts";
import { createProvider, EkuboListener } from "./indexer/listener.ts";
import { startBurnDigestPoller } from "./indexer/burn-poller.ts";
import { startNftActivityPoller } from "./indexer/nft-activity.ts";

async function main(): Promise<void> {
  assertConfig();
  openDb();
  bumpAthForAddress(SLAY_TOKEN, SLAY_ATH_USD);
  const provider = createProvider();
  const bot = new Bot(config.telegramToken);

  registerAdmin(bot, provider);
  registerChartCommand(bot);
  registerEliCommand(bot);
  registerShillCommand(bot, provider);
  registerWheelCommand(bot, provider);
  const onSwap = attachDispatcher(bot);
  const onNftAlert = attachNftDispatcher(bot);
  const onBurnDigest = attachBurnDispatcher(bot);
  const listener = new EkuboListener(provider, onSwap);

  bot.catch((err) => {
    console.error("Bot error:", err.error);
  });

  await listener.start();
  await startNftActivityPoller(onNftAlert);
  await startBurnDigestPoller(provider, onBurnDigest);
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
