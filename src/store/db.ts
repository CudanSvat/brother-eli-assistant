import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../config.ts";
import { normalizeAddress } from "../lib/format.ts";
import type { TokenSettings } from "../types.ts";

let db: Database.Database;

interface TokenRow {
  id: number;
  chat_id: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  pair_address: string | null;
  quote_address: string | null;
  min_usd: number;
  emoji: string;
  sell_emoji: string;
  emoji_step_usd: number;
  gif_url: string | null;
  whale_gif_url: string | null;
  ath_gif_url: string | null;
  whale_usd: number | null;
  chart_enabled: number;
  alert_buys: number;
  alert_sells: number;
  price_alert_pct: number | null;
  last_price_usd: number | null;
  ath_price_usd: number | null;
}

function mapToken(row: TokenRow): TokenSettings {
  return {
    id: row.id,
    chatId: row.chat_id,
    address: row.address,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    pairAddress: row.pair_address,
    quoteAddress: row.quote_address,
    minUsd: row.min_usd,
    emoji: row.emoji,
    emojiStepUsd: row.emoji_step_usd,
    gifUrl: row.gif_url,
    whaleGifUrl: row.whale_gif_url,
    athGifUrl: row.ath_gif_url,
    whaleUsd: row.whale_usd ?? 500,
    chartEnabled: Boolean(row.chart_enabled),
    priceAlertPct: row.price_alert_pct,
    lastPriceUsd: row.last_price_usd,
    athPriceUsd: row.ath_price_usd,
  };
}

export function openDb(): Database.Database {
  if (db) return db;
  const file = path.resolve(config.databasePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      chat_id INTEGER PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      address TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      decimals INTEGER NOT NULL DEFAULT 18,
      pair_address TEXT,
      quote_address TEXT,
      min_usd REAL NOT NULL DEFAULT 100,
      emoji TEXT NOT NULL DEFAULT '🟢',
      sell_emoji TEXT NOT NULL DEFAULT '🔴',
      emoji_step_usd REAL NOT NULL DEFAULT 50,
      gif_url TEXT,
      whale_gif_url TEXT,
      whale_usd REAL NOT NULL DEFAULT 500,
      chart_enabled INTEGER NOT NULL DEFAULT 1,
      alert_buys INTEGER NOT NULL DEFAULT 1,
      alert_sells INTEGER NOT NULL DEFAULT 0,
      price_alert_pct REAL,
      last_price_usd REAL,
      created_at INTEGER NOT NULL,
      UNIQUE(chat_id, address)
    );

    CREATE INDEX IF NOT EXISTS idx_tokens_address ON tokens(address);

    CREATE TABLE IF NOT EXISTS dm_sessions (
      user_id INTEGER PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const cols = db.pragma("table_info(tokens)") as { name: string }[];
  if (!cols.some((col) => col.name === "whale_usd")) {
    db.exec("ALTER TABLE tokens ADD COLUMN whale_usd REAL NOT NULL DEFAULT 500");
  }
  if (!cols.some((col) => col.name === "ath_price_usd")) {
    db.exec("ALTER TABLE tokens ADD COLUMN ath_price_usd REAL");
  }
  if (!cols.some((col) => col.name === "ath_gif_url")) {
    db.exec("ALTER TABLE tokens ADD COLUMN ath_gif_url TEXT");
  }
  return db;
}

export function upsertGroup(chatId: number, title?: string): void {
  openDb()
    .prepare(
      `INSERT INTO groups (chat_id, title, created_at)
       VALUES (@chatId, @title, @createdAt)
       ON CONFLICT(chat_id) DO UPDATE SET title = COALESCE(@title, title)`,
    )
    .run({ chatId, title: title ?? null, createdAt: Date.now() });
}

export function getGroup(chatId: number): { chatId: number; title: string | null } | undefined {
  const row = openDb()
    .prepare("SELECT chat_id, title FROM groups WHERE chat_id = ?")
    .get(chatId) as { chat_id: number; title: string | null } | undefined;
  return row ? { chatId: row.chat_id, title: row.title } : undefined;
}

export function deleteGroup(chatId: number): void {
  openDb().prepare("DELETE FROM groups WHERE chat_id = ?").run(chatId);
}

export function clearDmSessionsForGroup(chatId: number): void {
  openDb().prepare("DELETE FROM dm_sessions WHERE chat_id = ?").run(chatId);
}

export function listGroups(): { chatId: number; title: string | null }[] {
  const rows = openDb()
    .prepare("SELECT chat_id, title FROM groups ORDER BY created_at DESC")
    .all() as { chat_id: number; title: string | null }[];
  return rows.map((row) => ({ chatId: row.chat_id, title: row.title }));
}

export function getDmSession(userId: number): number | null {
  const row = openDb()
    .prepare("SELECT chat_id FROM dm_sessions WHERE user_id = ?")
    .get(userId) as { chat_id: number } | undefined;
  return row?.chat_id ?? null;
}

export function setDmSession(userId: number, chatId: number): void {
  openDb()
    .prepare(
      `INSERT INTO dm_sessions (user_id, chat_id, updated_at)
       VALUES (@userId, @chatId, @updatedAt)
       ON CONFLICT(user_id) DO UPDATE SET chat_id = @chatId, updated_at = @updatedAt`,
    )
    .run({ userId, chatId, updatedAt: Date.now() });
}

export function clearDmSession(userId: number): void {
  openDb().prepare("DELETE FROM dm_sessions WHERE user_id = ?").run(userId);
}

export function listTokens(chatId: number): TokenSettings[] {
  const rows = openDb()
    .prepare("SELECT * FROM tokens WHERE chat_id = ? ORDER BY id ASC")
    .all(chatId) as TokenRow[];
  return rows.map(mapToken);
}

export function countTokens(chatId: number): number {
  const row = openDb()
    .prepare("SELECT COUNT(*) AS n FROM tokens WHERE chat_id = ?")
    .get(chatId) as { n: number };
  return row.n;
}

export function getToken(id: number): TokenSettings | undefined {
  const row = openDb().prepare("SELECT * FROM tokens WHERE id = ?").get(id) as TokenRow | undefined;
  return row ? mapToken(row) : undefined;
}

export function tokensByAddress(address: string): TokenSettings[] {
  const rows = openDb()
    .prepare("SELECT * FROM tokens WHERE address = ?")
    .all(normalizeAddress(address)) as TokenRow[];
  return rows.map(mapToken);
}

export function allTrackedAddresses(): string[] {
  const rows = openDb().prepare("SELECT DISTINCT address FROM tokens").all() as { address: string }[];
  return rows.map((row) => row.address);
}

export function insertToken(input: {
  chatId: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  pairAddress: string | null;
  quoteAddress: string | null;
}): TokenSettings {
  const result = openDb()
    .prepare(
      `INSERT INTO tokens (
         chat_id, address, symbol, name, decimals, pair_address, quote_address, created_at
       ) VALUES (
         @chatId, @address, @symbol, @name, @decimals, @pairAddress, @quoteAddress, @createdAt
       )`,
    )
    .run({
      chatId: input.chatId,
      address: normalizeAddress(input.address),
      symbol: input.symbol,
      name: input.name,
      decimals: input.decimals,
      pairAddress: input.pairAddress,
      quoteAddress: input.quoteAddress,
      createdAt: Date.now(),
    });
  const token = getToken(Number(result.lastInsertRowid));
  if (!token) throw new Error("Failed to insert token");
  return token;
}

export function deleteToken(id: number, chatId: number): boolean {
  const result = openDb()
    .prepare("DELETE FROM tokens WHERE id = ? AND chat_id = ?")
    .run(id, chatId);
  return result.changes > 0;
}

export function updateToken(
  id: number,
  patch: Partial<{
    minUsd: number;
    emoji: string;
    emojiStepUsd: number;
    gifUrl: string | null;
    whaleGifUrl: string | null;
    athGifUrl: string | null;
    whaleUsd: number;
    chartEnabled: boolean;
    priceAlertPct: number | null;
    lastPriceUsd: number | null;
    athPriceUsd: number | null;
    pairAddress: string | null;
    quoteAddress: string | null;
  }>,
): TokenSettings | undefined {
  const current = getToken(id);
  if (!current) return undefined;
  const next = { ...current, ...patch };
  openDb()
    .prepare(
      `UPDATE tokens SET
         min_usd = @minUsd,
         emoji = @emoji,
         emoji_step_usd = @emojiStepUsd,
         gif_url = @gifUrl,
         whale_gif_url = @whaleGifUrl,
         ath_gif_url = @athGifUrl,
         whale_usd = @whaleUsd,
         chart_enabled = @chartEnabled,
         price_alert_pct = @priceAlertPct,
         last_price_usd = @lastPriceUsd,
         ath_price_usd = @athPriceUsd,
         pair_address = @pairAddress,
         quote_address = @quoteAddress
       WHERE id = @id`,
    )
    .run({
      id,
      minUsd: next.minUsd,
      emoji: next.emoji,
      emojiStepUsd: next.emojiStepUsd,
      gifUrl: next.gifUrl,
      whaleGifUrl: next.whaleGifUrl,
      athGifUrl: next.athGifUrl,
      whaleUsd: next.whaleUsd,
      chartEnabled: next.chartEnabled ? 1 : 0,
      priceAlertPct: next.priceAlertPct,
      lastPriceUsd: next.lastPriceUsd,
      athPriceUsd: next.athPriceUsd,
      pairAddress: next.pairAddress,
      quoteAddress: next.quoteAddress,
    });
  return getToken(id);
}

/** Keep ATH in sync for every group tracking the same token. */
export function bumpAthForAddress(address: string, athPriceUsd: number): void {
  if (!Number.isFinite(athPriceUsd) || athPriceUsd <= 0) return;
  openDb()
    .prepare(
      `UPDATE tokens SET ath_price_usd = @ath
       WHERE address = @address AND (ath_price_usd IS NULL OR ath_price_usd < @ath)`,
    )
    .run({ address: normalizeAddress(address), ath: athPriceUsd });
}

/** Set ATH for a token in every group, including clamping a fake high back down. */
export function setAthForAddress(address: string, athPriceUsd: number): void {
  if (!Number.isFinite(athPriceUsd) || athPriceUsd <= 0) return;
  openDb()
    .prepare(`UPDATE tokens SET ath_price_usd = @ath WHERE address = @address`)
    .run({ address: normalizeAddress(address), ath: athPriceUsd });
}
