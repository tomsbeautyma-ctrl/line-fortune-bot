// index.js — STORES連携ナシ版：注文番号入力で「1週間チャット解放」
// ------------------------------------------------------------
// 概要:
// ・ユーザーが「注文番号（アクセスコード）」を送ると、その瞬間から7日間チャット解放
// ・STORES APIは一切使いません
// ・Redisでエンタイトルメント（有効期限）とコード使用済み管理
// ・安全運用のため 2モード対応：
//    - CODE_MODE="free"   : 任意の注文番号（一定の正規表現を通過）で解放（手軽だが悪用注意）
//    - CODE_MODE="signed" : 管理側が発行した署名つきコードのみ受付（推奨）
// ・管理者用ミントAPI /mint 付き（CODE_MODE=signedのコードを発行）
// ・LINE検証タイムアウト回避（即200）
// ------------------------------------------------------------

import express from "express";
import crypto from "crypto";
import axios from "axios";
import { Redis } from "@upstash/redis";

// ------------------------------------------------------------
// 環境変数（名称ゆらぎに両対応）
// ------------------------------------------------------------
const {
  PORT = 3000,
  // LINE
  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_ACCESS_TOKEN, // 別名
  // Upstash
  UPSTASH_REDIS_URL,
  UPSTASH_REDIS_TOKEN,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  // アクセス設定
  ACCESS_DURATION_DAYS = "7", // 既定で7日
  CODE_MODE = "signed", // "signed"（推奨） or "free"
  ACCESS_CODE_SECRET, // CODE_MODE=signed時に必須（HMAC署名用）
  REQUIRE_CODE_PREFIX = "", // 例: "ST" を指定すると ST から始まるコードのみ受付
  // 管理用
  ADMIN_TOKEN, // /mint に必要
} = process.env;

const LINE_TOKEN = LINE_CHANNEL_ACCESS_TOKEN || LINE_ACCESS_TOKEN;
const REDIS_URL = UPSTASH_REDIS_URL || UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = UPSTASH_REDIS_TOKEN || UPSTASH_REDIS_REST_TOKEN;

if (!LINE_CHANNEL_SECRET || !LINE_TOKEN) console.error("LINEの環境変数が未設定です");
if (!REDIS_URL || !REDIS_TOKEN) console.error("Upstash Redisの環境変数が未設定です");
if (CODE_MODE === "signed" && !ACCESS_CODE_SECRET) console.error("CODE_MODE=signed ですが ACCESS_CODE_SECRET が未設定です");

const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
const app = express();
app.use(express.json({ verify: (req, _res, buf) => (req.rawBody = buf) }));

// ------------------------------------------------------------
// 署名検証（LINE）
// ------------------------------------------------------------
function validateLineSignature(req) {
  const signature = req.headers["x-line-signature"];
  if (!signature) return false;
  const hmac = crypto.createHmac("SHA256", LINE_CHANNEL_SECRET);
  hmac.update(req.rawBody);
  return signature === hmac.digest("base64");
}

// ------------------------------------------------------------
// Redis Keys
// ------------------------------------------------------------
const entitlementKey = (userId) => `entitlement:${userId}`; // { expiresAt, code }
const usedCodeKey = (code) => `used_code:${code}`;          // 固定値 "true"

// ------------------------------------------------------------
// ユーティリティ
// ------------------------------------------------------------
const daysToMs = (d) => Number(d) * 24 * 60 * 60 * 1000;

async function replyText(replyToken, text) {
  try {
    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      { replyToken, messages: [{ type: "text", text }] },
      { headers: { Authorization: `Bearer ${LINE_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("LINE返信エラー", e?.response?.data || e.message);
  }
}

function formatJST(ts) {
  const d = new Date(ts);
  return d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

// ------------------------------------------------------------
// コード検証ロジック
// ------------------------------------------------------------
// freeモード: 指定の前方一致（任意）とフォーマット（英数/ハイフン/先頭2文字以上）
function looksLikeOrderCode(code) {
  if (REQUIRE_CODE_PREFIX && !code.startsWith(REQUIRE_CODE_PREFIX)) return false;
  return /^[A-Z0-9][A-Z0-9\-]{5,}$/i.test(code);
}

// signedモード: HMAC-SHA256 で署名された自己完結コード
// 形式: PREFIX(optional)+base(ランダム) + ":" + sig
// 表示コードは base + "-" + sigShort
function signBase(base) {
  const mac = crypto.createHmac("sha256", ACCESS_CODE_SECRET).update(base).digest("hex");
  return mac; // 64hex
}
function verifySignedCode(code) {
  // 表示形式: <prefix?><base>-<sig8>
  const m = code.match(/^([A-Z0-9]+-)?([A-Z0-9]{8,})-([a-f0-9]{8})$/i);
  if (!m) return false;
  const base = m[2];
  const sig8 = m[3].toLowerCase();
  const mac = signBase(base).slice(0, 8);
  return mac === sig8;
}

// ------------------------------------------------------------
// エンタイトルメント: 付与・照会
// ------------------------------------------------------------
async function grantEntitlement(userId, code) {
  // コード使い回しを防ぐ: 既に使用済みか
  const used = await redis.get(usedCodeKey(code));
  if (used) return { ok: false, reason: "CODE_USED" };

  const now = Date.now();
  const expiresAt = now + daysToMs(ACCESS_DURATION_DAYS);

  const ent = { code, grantedAt: now, expiresAt };
  await redis.set(entitlementKey(userId), ent, { ex: Math.ceil((expiresAt - now) / 1000) + 60 });
  await redis.set(usedCodeKey(code), "true", { ex: Math.ceil((expiresAt - now) / 1000) + 60 });
  return { ok: true, ent };
}

async function getEntitlement(userId) {
  return await redis.get(entitlementKey(userId));
}

// ------------------------------------------------------------
// Webhook（即200 → 非同期処理）
// ------------------------------------------------------------
app.post("/webhook", async (req, res) => {
  res.status(200).end();
  try {
    const hasSig = !!req.headers["x-line-signature"];
    if (hasSig && !validateLineSignature(req)) {
      console.warn("Invalid LINE signature");
      return;
    }

    const events = req.body?.events || [];
    for (const ev of events) {
      if (ev.type !== "message" || ev.message.type !== "text") continue;

      const replyToken = ev.replyToken;
      const userId = ev.source?.userId;
      const text = (ev.message.text || "").trim();

      // コマンド系
      if (/^status$/i.test(text)) {
        const ent = await getEntitlement(userId);
        if (!ent) {
          await replyText(replyToken, "現在ご利用中の権利はありません。注文番号（アクセスコード）を送って開始してください。");
        } else {
          await replyText(
            replyToken,
            `ご利用は ${formatJST(ent.expiresAt)} まで有効です。\nコード: ${ent.code}`
          );
        }
        continue;
      }

      // まだ権利が無ければ、コードとして扱う
      const ent = await getEntitlement(userId);
      if (!ent) {
        const code = text.replace(/\s+/g, "");
        const accept = CODE_MODE === "signed" ? verifySignedCode(code) : looksLikeOrderCode(code);
        if (!accept) {
          const modeHint = CODE_MODE === "signed" ? "有効なアクセスコード形式ではありません。" : "注文番号の形式ではありません。";
          await replyText(
            replyToken,
            `${modeHint}\n・例（signed）: ABCD1234-1a2b3c4d\n・例（free）: ${REQUIRE_CODE_PREFIX || "任意の英数字先頭"}123456`
          );
          continue;
        }

        const granted = await grantEntitlement(userId, code);
        if (!granted.ok) {
          await replyText(replyToken, "このコードは既に使用されています。別のコードをご利用ください。");
          continue;
        }

        await replyText(
          replyToken,
          `アクセスを開始しました。\n有効期間: ${ACCESS_DURATION_DAYS}日間\n終了日時: ${formatJST(granted.ent.expiresAt)}\n\nご質問を送ってください。`
        );
        continue;
      }

      // 権利がある → 期限内か判定
      if (Date.now() > ent.expiresAt) {
        await replyText(replyToken, "有効期限が切れています。新しいコードを送信して再開してください。");
        continue;
      }

      // ここで本来の鑑定/応答処理
      const answer = await generateAnswer(text);
      await replyText(replyToken, answer);
    }
  } catch (e) {
    console.error("Webhook処理エラー", e);
  }
});

// ------------------------------------------------------------
// 管理者: 署名つきコード発行API（CODE_MODE=signed向け）
// 例) POST /mint { count: 5, prefix: "ST" }
//     Authorization: Bearer <ADMIN_TOKEN>
// ------------------------------------------------------------
app.post("/mint", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    if (!ADMIN_TOKEN || auth !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: "unauthorized" });

    const { count = 1, prefix = REQUIRE_CODE_PREFIX || "" } = req.body || {};
    if (CODE_MODE !== "signed") return res.status(400).json({ error: "CODE_MODE is not 'signed'" });
    if (!ACCESS_CODE_SECRET) return res.status(500).json({ error: "ACCESS_CODE_SECRET not set" });

    const out = [];
    for (let i = 0; i < Math.max(1, Math.min(1000, Number(count) || 1)); i++) {
      const base = crypto.randomBytes(6).toString("hex"); // 12hex
      const sig8 = signBase(base).slice(0, 8);
      const code = `${prefix ? prefix + "-" : ""}${base.toUpperCase()}-${sig8}`;
      out.push(code);
    }
    res.json({ codes: out, mode: CODE_MODE, days: Number(ACCESS_DURATION_DAYS) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------------------
// ヘルスチェック/検証用
// ------------------------------------------------------------
app.get("/health", (_req, res) => res.json({ ok: true, mode: CODE_MODE, days: Number(ACCESS_DURATION_DAYS) }));
app.get("/webhook", (_req, res) => res.status(200).send("OK"));

// ------------------------------------------------------------
// 応答ダミー（本番では占いロジック等に差し替え）
// ------------------------------------------------------------
async function generateAnswer(q) {
  return `【回答】\nご質問: ${q}\n\n今は焦らず、できる一歩から。1週間いつでもご相談ください。`;
}

// ------------------------------------------------------------
app.listen(PORT, () => console.log(`LISTEN: http://0.0.0.0:${PORT}`));
