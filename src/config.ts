import "dotenv/config";
import { hash } from "starknet";

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || "",
  rpcUrl: process.env.STARKNET_RPC_URL?.trim() || "https://api.cartridge.gg/x/starknet/mainnet",
  wsUrl: process.env.STARKNET_WS_URL?.trim() || "",
  databasePath: process.env.DATABASE_PATH?.trim() || "data/brother-eli.db",
  maxTokensPerGroup: 10,
  hopFlushMs: 1_500,
  pollIntervalMs: 4_000,
  chartCacheMs: 15_000,
};

export function assertConfig(): void {
  if (!config.telegramToken) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN. Copy .env.example to .env.");
  }
}

export const BOT_NAME = "Brother Eli Assistant";
export const BOT_TAGLINE = "Your Starknet helper in Telegram";
export const BOT_ABOUT =
  "A Starknet helper for Telegram groups. Live buy alerts, charts, and GIFs now — more tools on the way.";

export const EKUBO_CORE =
  "0x00000005dd3D2F4429AF886cD1a3b08289DBcEa99A294197E9eB43b0e0325b4b";

export const SWAPPED_SELECTOR = hash.getSelectorFromName("Swapped");

export const QUOTE_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7": {
    symbol: "ETH",
    decimals: 18,
  },
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d": {
    symbol: "STRK",
    decimals: 18,
  },
  "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8": {
    symbol: "USDC",
    decimals: 6,
  },
  "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb": {
    symbol: "USDC",
    decimals: 6,
  },
  "0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8": {
    symbol: "USDT",
    decimals: 6,
  },
  "0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac": {
    symbol: "WBTC",
    decimals: 8,
  },
  "0x05574eb6b8789a91466f902c380d978e472db68170ff82a5babc4a27a4db1c5": {
    symbol: "LORDS",
    decimals: 18,
  },
};
