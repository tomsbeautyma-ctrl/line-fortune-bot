// index.js — 1週間使い放題（¥1,650）のみ版
// ・注文番号をLINEで送る→決済確認→7日パス付与
// ・7日以内は質問し放題、期限後は自動ロック＆購入案内
// ・同一注文番号は「最初に紐づけたLINEユーザー」だけが使える（共有防止）
// ・STORESは order_id / order_number のどちらでも照会
// ・Upstash Redis で権利を保持
// ・OpenAI 返答は簡易（必要に応じて調整）

import express from "express";
import crypto from "crypto";
import axios from "axios";
import { Redis } from "@upstash/redis";

// ───────────────────────────────────────────────────────────
// 環境変数
// ───────────────────────────────────────────────────────────
const {
  PORT = 3000,

  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_ACCESS_TOKEN, // 別名サポート

  // STORES
  STORES_API_KEY,
  STORES_BEARER,            // APIキー名のゆらぎ対策（どちらか1つでOK）
  STORES_SHOP_ID,           // 例: "beauty-one"（サブドメインのみ）
  STORES_API_BASE,          // 省略可: 既定 https://api.stores.jp
  STORES_SHOP_URL,          // 未購入時に案内するショップURL（任意）

  // 1週間パス対象商品のID（product_id / sku / handle のいずれか）
  WEEKPASS_PRODUCT_ID,

  // OpenAI
  OPENAI_API_KEY,
  MODEL = "gpt-4o-mini",

  // Upstash Redis（REST/通常どちらでも）
  UPSTASH_REDIS_URL,
  UPSTASH_REDIS_TOKEN,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
} = process.env;

const LINE_TOKEN = LINE_CHANNEL_ACCESS_TOKEN || LINE_ACCESS_TOKEN;
const REDIS_URL = UPSTASH_REDIS_URL || UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = UPSTASH_REDIS_TOKEN || UPSTASH_REDIS_REST_TOKEN;
const STORES_BASE = (STORES_API_BASE || "https://api.stores.jp").replace(/\/$/, "");
const STORES_AUTH = STORES_API_KEY || STORES_BEARER;

if (!LINE_CHANNEL_SECRET || !LINE_TOKEN) console.error("[warn] LINE env 未設定");
if (!STORES_AUTH || !STORES_SHOP_ID) console.error("[warn] STORES env 未設定");
if (!WEEKPASS_PRODUCT_ID) console.error("[warn] WEEKPASS_PRODUCT_ID 未設定");
if (!REDIS_URL || !REDIS_TOKEN) console.error("[warn] Upstash env 未設定");
if (!OPENAI_API_KEY) console.error("[warn] OPENAI_API_KEY 未設定");

const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
const app = express();
app.use(express.json({ verify: (req, _res, buf) => (req.rawBody = buf) }));

// ───────────────────────────────────────────────────────────
// 署名検証
// ───────────────────────────────────────────────────────────
function validateLineSignature(req) {
  const signature = req.headers["x-line-signature"];
  if (!signature) return false;
  const hmac = crypto.createHmac("SHA256", LINE_CHANNEL_SECRET);
  hmac.update(req.rawBody);
  return signature === hmac.digest("base64");
}

// ───────────────────────────────────────────────────────────
// ヘルスチェック
// ───────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get("/webhook", (_req, res) => res.status(200).send("OK"));

// ───────────────────────────────────────────────────────────
// STORES: 注文取得 & 決済判定
// ───────────────────────────────────────────────────────────
async function fetchStoresOrder(orderIdOrNumber) {
  const shop = encodeURIComponent(STORES_SHOP_ID);
  const headers = { Authorization: `Bearer ${STORES_AUTH}`, "Content-Type": "application/json" };

  // 1) /orders/{id}
  const byIdUrl = `${STORES_BASE}/v1/shops/${shop}/orders/${encodeURIComponent(orderIdOrNumber)}`;
  try {
    const { data } = await axios.get(byIdUrl, { headers, timeout: 15000 });
    return data;
  } catch (e) {
    if (e?.response?.status !== 404) throw e;
  }

  // 2) /orders?order_number=...
  const byNumberUrl = `${STORES_BASE}/v1/shops/${shop}/orders?order_number=${encodeURIComponent(orderIdOrNumber)}`;
  const { data } = await axios.get(byNumberUrl, { headers, timeout: 15000 });
  if (Array.isArray(data?.orders) && data.orders.length > 0) return data.orders[0];
  if (Array.isArray(data) && data.length > 0) return data[0];

  const err = new Error("Order not found");
  err.status = 404;
  err.endpointTried = { byIdUrl, byNumberUrl };
  throw err;
}

function isPaid(order) {
  const st = (order?.status || "").toLowerCase();
  const ok = ["paid", "captured", "shipped", "fulfilled"].includes(st);
  const ng = ["cancelled", "canceled", "refunded"].includes(st);
  return ok && !ng;
}

function extractIds(order) {
  const items = order?.line_items || [];
  return items.map(li => li.product_id || li.sku || li.handle).filter(Boolean);
}

// その注文が「1週間パス商品」を含むか
function isWeekPassOrder(order) {
  const ids = extractIds(order);
  return WEEKPASS_PRODUCT_ID && ids.includes(WEEKPASS_PRODUCT_ID);
}

// ───────────────────────────────────────────────────────────
// Redis Keys
// ───────────────────────────────────────────────────────────
const entitlementKey = (userId)  => `wk_entitlement:${userId}`; // {orderId, expiresAt}
const orderOwnerKey  = (orderId) => `wk_order_owner:${orderId}`; // 共有防止 userId
const LAST_GUIDE_KEY = (userId)  => `wk_last_guide:${userId}`;   // 案内頻度制御（任意）

// ───────────────────────────────────────────────────────────
// LINE返信
// ───────────────────────────────────────────────────────────
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

function guideMessage() {
  const url = STORES_SHOP_URL || "ショップ";
  return [
    "【ご利用案内】",
    "このチャットはご購入者さま向けのサービスです。",
    "1,650円で「1週間 質問し放題」。",
    "ご購入後、STORESの『注文番号』をこのトークに送ると、すぐにご利用開始できます。",
    "",
    `ご購入はこちら：${url}`
  ].join("\n");
}

// ───────────────────────────────────────────────────────────
// Webhook
// ───────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.status(200).end(); // タイムアウト回避

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

      const orderIdCandidate = parseOrderId(text);
      if (orderIdCandidate) {
        await handleRegistration({ replyToken, userId, orderId: orderIdCandidate });
      } else {
        await handleQuestion({ replyToken, userId, question: text });
      }
    }
  } catch (e) {
    console.error("Webhook処理エラー", e);
  }
});

// 注文番号抽出（「認証 123456」「STxxxx」等）
function parseOrderId(text) {
  const m = text.match(/\b(?:認証|注文|order)?\s*(ST[\w-]+|\d{6,})\b/i);
  return m ? m[1] : null;
}

// ───────────────────────────────────────────────────────────
// 認証（注文 → 7日パス付与）
// ───────────────────────────────────────────────────────────
async function handleRegistration({ replyToken, userId, orderId }) {
  try {
    const order = await fetchStoresOrder(orderId);

    if (!isPaid(order)) {
      await replyText(replyToken, "未決済またはキャンセルのため承認できません。決済後に再度お試しください。");
      return;
    }
    if (!isWeekPassOrder(order)) {
      await replyText(replyToken, "この注文は「1週間使い放題」商品のご購入ではありません。ご確認ください。");
      return;
    }

    // 共有防止：この注文番号が別ユーザーに既に紐づいていないか
    const owner = await redis.get(orderOwnerKey(orderId));
    if (owner && owner !== userId) {
      await replyText(replyToken, "この注文番号はすでに別のLINEアカウントに登録されています。");
      return;
    }

    // 7日間の権利を付与（登録時刻から）
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const ent = { orderId, grantedAt: Date.now(), expiresAt: Date.now() + sevenDays };

    // 保存（90日キャッシュ。キー期限は長めに）
    await redis.set(entitlementKey(userId), ent, { ex: 60 * 60 * 24 * 90 });
    await redis.set(orderOwnerKey(orderId), userId, { ex: 60 * 60 * 24 * 90 });

    const end = new Date(ent.expiresAt).toLocaleString("ja-JP", { hour12: false });
    await replyText(
      replyToken,
      `注文番号(${orderId})を確認しました。\n「1週間使い放題」パスを付与しました。\n有効期限：${end}\n\nご質問をどうぞ。`
    );
  } catch (e) {
    console.error("認証エラー", e?.response?.data || e.message);
    await replyText(replyToken, "注文確認でエラーが発生しました。時間をおいて再度お試しください。");
  }
}

// ───────────────────────────────────────────────────────────
// 質問（権利チェック → 回答）
// ───────────────────────────────────────────────────────────
async function handleQuestion({ replyToken, userId, question }) {
  const ent = await redis.get(entitlementKey(userId));

  if (!ent) {
    // 連投でうるさくならないよう、直近15分は案内を1回だけ
    const guided = await redis.get(LAST_GUIDE_KEY + ":" + userId);
    if (!guided) {
      await replyText(replyToken, guideMessage());
      await redis.set(LAST_GUIDE_KEY + ":" + userId, "1", { ex: 60 * 15 });
    }
    return;
  }

  if (Date.now() > ent.expiresAt) {
    await replyText(replyToken, "有効期限が切れました。お手数ですが再度ご購入ください。\n\n" + guideMessage());
    return;
  }

  const answer = await generateFortune(question);
  await replyText(replyToken, answer);

  // 期限まで質問し放題（追加処理なし）
}

// ───────────────────────────────────────────────────────────
// OpenAI（簡易）
// ───────────────────────────────────────────────────────────
async function generateFortune(q) {
  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: MODEL,
        messages: [
          { role: "system", content: "あなたは思いやりのある占い師です。簡潔で前向きな助言を返してください。最後は一言の背中押しで締めてください。" },
          { role: "user", content: `相談内容: ${q}` }
        ],
        temperature: 0.7,
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" }, timeout: 20000 }
    );
    const text = resp.data?.choices?.[0]?.message?.content?.trim();
    if (text) return `【占い結果】\n${text}`;
  } catch (e) {
    console.error("OpenAIエラー", e?.response?.data || e.message);
  }
  return `【占い結果】\nご相談: ${q}\n\n今は深呼吸を。視点を少し変えるだけで道が開けます。`;
}

// ───────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`LISTEN: http://0.0.0.0:${PORT}`));
