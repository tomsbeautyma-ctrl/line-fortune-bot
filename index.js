// ===== 1週間使い放題（¥1,650）専用・最小構成 =====
// ・注文番号をLINEで送る → STORESで決済確認 → 7日パス付与
// ・7日以内は質問し放題、期限後は購入案内
// ・同一注文番号は最初に紐づけたLINEユーザーのみ使用可（共有防止）
// ・環境変数は下の「設定一覧」を参照
// --------------------------------------------------

import express from "express";
import crypto from "crypto";
import axios from "axios";
import { Redis } from "@upstash/redis";

// ===== 環境変数 =====
const {
  PORT = 3000,

  LINE_CHANNEL_SECRET,
  LINE_ACCESS_TOKEN,                  // LINE長期トークン

  STORES_API_KEY,                     // 生キーのみ（Bearerは付けない！）
  STORES_BEARER,                      // ↑未設定ならこちらでも可（どちらか1つ）
  STORES_SHOP_ID,                     // 例: beauty-one（サブドメインだけ）
  STORES_API_BASE = "https://api.stores.jp",
  STORES_SHOP_URL,                    // 未購入案内に載せるURL（任意）

  WEEKPASS_PRODUCT_ID,                // 1週間パス商品の product_id / sku / handle のいずれか

  OPENAI_API_KEY,
  MODEL = "gpt-4o-mini",

  UPSTASH_REDIS_URL,
  UPSTASH_REDIS_TOKEN,

  DEBUG                                // "1" で簡易デバッグログ
} = process.env;

// ---- 便利: Bearerが誤って含まれても除去 ----
const normBearer = v => (v || "").replace(/^Bearer\s+/i, "").trim();
const STORES_TOKEN = normBearer(STORES_API_KEY || STORES_BEARER);

// ---- チェック（起動は継続。ログのみ） ----
if (!LINE_CHANNEL_SECRET || !LINE_ACCESS_TOKEN) console.error("[warn] LINE env 未設定");
if (!STORES_TOKEN || !STORES_SHOP_ID) console.error("[warn] STORES env 未設定");
if (!WEEKPASS_PRODUCT_ID) console.error("[warn] WEEKPASS_PRODUCT_ID 未設定");
if (!UPSTASH_REDIS_URL || !UPSTASH_REDIS_TOKEN) console.error("[warn] Upstash env 未設定");
if (!OPENAI_API_KEY) console.error("[warn] OPENAI_API_KEY 未設定");

const app = express();
app.use(express.json({ verify: (req, _res, buf) => (req.rawBody = buf) }));
const redis = new Redis({ url: UPSTASH_REDIS_URL, token: UPSTASH_REDIS_TOKEN });

// ===== 署名検証 =====
function verifyLineSig(req) {
  const sig = req.headers["x-line-signature"];
  if (!sig) return false;
  const mac = crypto.createHmac("SHA256", LINE_CHANNEL_SECRET);
  mac.update(req.rawBody);
  return sig === mac.digest("base64");
}

// ===== 便利関数 =====
const entKey   = uid => `wk:ent:${uid}`;          // { orderId, expiresAt }
const ownerKey = oid => `wk:owner:${oid}`;        // userId（共有防止）
const guideKey = uid => `wk:guide:${uid}`;        // 未購入案内の連投抑止

async function replyText(replyToken, text) {
  try {
    await axios.post("https://api.line.me/v2/bot/message/reply",
      { replyToken, messages: [{ type: "text", text }] },
      { headers: { Authorization: `Bearer ${LINE_ACCESS_TOKEN}` } }
    );
  } catch (e) {
    console.error("LINE返信エラー:", e?.response?.data || e.message);
  }
}

function guide() {
  const url = STORES_SHOP_URL || "ショップ";
  return [
    "【ご利用案内】",
    "このチャットはご購入者さま向けです。",
    "1,650円で『1週間・質問し放題』。",
    "ご購入後、STORESの注文番号（例: ST123456）をこのトークに送ってください。",
    `ご購入はこちら：${url}`
  ].join("\n");
}

function parseOrderId(text) {
  const m = (text || "").match(/\b(?:認証|注文|order)?\s*(ST[\w-]+|\d{6,})\b/i);
  return m ? m[1] : null;
}

function paidStatus(order) {
  const st = (order?.status || "").toLowerCase();
  const ok = ["paid", "captured", "shipped", "fulfilled"].includes(st);
  const ng = ["cancelled", "canceled", "refunded"].includes(st);
  return ok && !ng;
}

// ===== STORES: 注文取得（ID→番号の順に試す） =====
async function fetchOrder(orderIdOrNumber) {
  const shop = encodeURIComponent(STORES_SHOP_ID);
  const headers = { Authorization: `Bearer ${STORES_TOKEN}` };

  const byIdUrl = `${STORES_API_BASE}/v1/shops/${shop}/orders/${encodeURIComponent(orderIdOrNumber)}`;
  try {
    DEBUG && console.log("[DEBUG] byId:", byIdUrl);
    const { data } = await axios.get(byIdUrl, { headers, timeout: 15000 });
    return data;
  } catch (e) {
    if (e?.response?.status !== 404) throw e;
  }

  const byNumUrl = `${STORES_API_BASE}/v1/shops/${shop}/orders?order_number=${encodeURIComponent(orderIdOrNumber)}`;
  DEBUG && console.log("[DEBUG] byNumber:", byNumUrl);
  const { data } = await axios.get(byNumUrl, { headers, timeout: 15000 });
  if (Array.isArray(data?.orders) && data.orders.length) return data.orders[0];
  if (Array.isArray(data) && data.length) return data[0];

  const err = new Error("Order not found");
  err.status = 404;
  throw err;
}

function isWeekPass(order) {
  const items = order?.line_items || [];
  const ids = items.map(li => li.product_id || li.sku || li.handle).filter(Boolean);
  return ids.includes(WEEKPASS_PRODUCT_ID);
}

// ===== ルーティング =====
app.get("/health", (_q, r) => r.json({ ok: true }));
app.get("/webhook", (_q, r) => r.send("OK"));

app.post("/webhook", async (req, res) => {
  res.status(200).end(); // LINEのタイムアウト回避

  try {
    if (req.headers["x-line-signature"] && !verifyLineSig(req)) {
      console.warn("Invalid LINE signature"); return;
    }
    const events = req.body?.events || [];
    for (const ev of events) {
      if (ev.type !== "message" || ev.message?.type !== "text") continue;

      const userId = ev.source?.userId;
      const replyToken = ev.replyToken;
      const text = (ev.message?.text || "").trim();

      const orderId = parseOrderId(text);
      if (orderId) {
        await handleRegister(replyToken, userId, orderId);
      } else {
        await handleQuestion(replyToken, userId, text);
      }
    }
  } catch (e) {
    console.error("Webhook処理エラー:", e);
  }
});

// ===== 認証（注文番号 → 7日権利） =====
async function handleRegister(replyToken, userId, orderId) {
  try {
    const order = await fetchOrder(orderId);

    if (!paidStatus(order)) {
      await replyText(replyToken, "未決済またはキャンセルのため承認できません。決済完了後にお試しください。");
      return;
    }
    if (!isWeekPass(order)) {
      await replyText(replyToken, "この注文は『1週間使い放題』商品のご購入ではありません。ご確認ください。");
      return;
    }

    // 共有防止：既に別ユーザーがこの注文を使っていないか
    const owner = await redis.get(ownerKey(orderId));
    if (owner && owner !== userId) {
      await replyText(replyToken, "この注文番号は別のLINEアカウントに登録済みです。");
      return;
    }

    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const ent = { orderId, grantedAt: Date.now(), expiresAt: Date.now() + sevenDays };

    await redis.set(entKey(userId), ent, { ex: 60 * 60 * 24 * 90 });
    await redis.set(ownerKey(orderId), userId, { ex: 60 * 60 * 24 * 90 });

    const endAt = new Date(ent.expiresAt).toLocaleString("ja-JP", { hour12: false });
    await replyText(replyToken, `注文番号(${orderId})を確認しました。\n『1週間・質問し放題』を付与しました。\n有効期限：${endAt}\n\nご質問をどうぞ。`);
  } catch (e) {
    console.error("認証エラー:", e?.response?.data || e.message);
    await replyText(replyToken, "注文確認でエラーが発生しました。時間をおいて再度お試しください。");
  }
}

// ===== 質問（権利チェック → 回答） =====
async function handleQuestion(replyToken, userId, question) {
  const ent = await redis.get(entKey(userId));
  if (!ent) {
    const guided = await redis.get(guideKey(userId));
    if (!guided) {
      await replyText(replyToken, guide());
      await redis.set(guideKey(userId), "1", { ex: 60 * 15 }); // 15分に1回だけ案内
    }
    return;
  }
  if (Date.now() > ent.expiresAt) {
    await replyText(replyToken, "有効期限が切れました。再度ご購入ください。\n\n" + guide());
    return;
  }

  const answer = await generateAnswer(question);
  await replyText(replyToken, answer);
}

// ===== OpenAI（簡易） =====
async function generateAnswer(q) {
  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: MODEL,
        messages: [
          { role: "system", content: "あなたは優しい占い師です。専門用語は使わず、要点を短く前向きに答え、最後は一言で背中を押してください。" },
          { role: "user", content: `相談内容: ${q}` }
        ],
        temperature: 0.7,
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, timeout: 20000 }
    );
    const txt = resp.data?.choices?.[0]?.message?.content?.trim();
    if (txt) return `【占い結果】\n${txt}`;
  } catch (e) {
    console.error("OpenAIエラー:", e?.response?.data || e.message);
  }
  return `【占い結果】\nご相談: ${q}\n\nまずは一呼吸。小さな一歩が流れを変えます。`;
}

// ===== 起動 =====
app.listen(PORT, () => console.log(`LISTEN: http://0.0.0.0:${PORT}`));
