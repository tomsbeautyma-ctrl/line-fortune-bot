// index.js — LINE Webhookタイムアウト対策＆環境変数名両対応版（丸ごとコピペOK）
// ------------------------------------------------------------
import express from "express";
import crypto from "crypto";
import axios from "axios";
import { Redis } from "@upstash/redis";

// ------------------------------------------------------------
// 環境変数（REST/通常 両対応）
// ------------------------------------------------------------
const {
  PORT = 3000,
  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_ACCESS_TOKEN, // 別名対応
  STORES_API_KEY,
  STORES_SHOP_ID,
  ONE_SHOT_PRODUCT_ID,
  MONTHLY_PRODUCT_ID,
  UPSTASH_REDIS_URL,
  UPSTASH_REDIS_TOKEN,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
} = process.env;

// LINEアクセストークン両対応
const LINE_TOKEN = LINE_CHANNEL_ACCESS_TOKEN || LINE_ACCESS_TOKEN;
// Upstash両対応
const REDIS_URL = UPSTASH_REDIS_URL || UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = UPSTASH_REDIS_TOKEN || UPSTASH_REDIS_REST_TOKEN;

if (!LINE_CHANNEL_SECRET || !LINE_TOKEN) console.error("LINEの環境変数が未設定です");
if (!STORES_API_KEY || !STORES_SHOP_ID) console.error("STORESの環境変数が未設定です");
if (!REDIS_URL || !REDIS_TOKEN) console.error("Upstash Redisの環境変数が未設定です");

const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
const app = express();
app.use(express.json({ verify: (req, _res, buf) => (req.rawBody = buf) }));

// ------------------------------------------------------------
// LINE署名検証
// ------------------------------------------------------------
function validateLineSignature(req) {
  const signature = req.headers["x-line-signature"];
  if (!signature) return false;
  const hmac = crypto.createHmac("SHA256", LINE_CHANNEL_SECRET);
  hmac.update(req.rawBody);
  return signature === hmac.digest("base64");
}

// ------------------------------------------------------------
// ヘルスチェック
// ------------------------------------------------------------
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get("/webhook", (_req, res) => res.status(200).send("OK"));

// ------------------------------------------------------------
// STORES API確認（ダミー関数）
// ------------------------------------------------------------
async function fetchStoresOrder(orderId) {
  const url = `https://api.stores.jp/v1/shops/${encodeURIComponent(
    STORES_SHOP_ID
  )}/orders/${encodeURIComponent(orderId)}`;
  const { data } = await axios.get(url, {
    headers: { Authorization: `Bearer ${STORES_API_KEY}` },
    timeout: 15000,
  });
  return data;
}
async function verifyPayment(orderId) {
  const order = await fetchStoresOrder(orderId);
  return order && (order.status === "paid" || order.status === "captured");
}

// ------------------------------------------------------------
// Redisキー生成
// ------------------------------------------------------------
const usedOrderKey = (id) => `used_order:${id}`;
const entitlementKey = (uid) => `entitlement:${uid}`;

// ------------------------------------------------------------
// LINE返信
// ------------------------------------------------------------
async function replyText(replyToken, text) {
  try {
    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      { replyToken, messages: [{ type: "text", text }] },
      { headers: { Authorization: `Bearer ${LINE_TOKEN}` } }
    );
  } catch (e) {
    console.error("LINE返信エラー", e?.response?.data || e.message);
  }
}

// ------------------------------------------------------------
// メインWebhook（タイムアウト回避の即200対応）
// ------------------------------------------------------------
app.post("/webhook", async (req, res) => {
  // すぐにHTTP 200を返す（検証時タイムアウト防止）
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

      const userId = ev.source?.userId;
      const text = (ev.message.text || "").trim();
      const replyToken = ev.replyToken;

      // 簡易実装：メッセージ受信確認
      await replyText(replyToken, `受信しました: ${text}`);
    }
  } catch (e) {
    console.error("Webhook処理エラー", e);
  }
});

// ------------------------------------------------------------
// ダミー占い関数（ここに本来の処理）
// ------------------------------------------------------------
async function generateFortune(q) {
  return `【鑑定結果】\nご相談: ${q}\n\n今は落ち着いて行動する時期です。前向きな変化が訪れます✨`;
}

// ------------------------------------------------------------
app.listen(PORT, () => console.log(`LISTEN: http://0.0.0.0:${PORT}`));

