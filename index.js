// index.js — 本番用: STORES決済チェック + 550円「1回のみ」ロック + 月額無制限
// 両対応: 環境変数の名称ゆらぎ / LINE検証タイムアウト回避 / Redis保存
// 丸ごとコピペOK（Renderに置き換えで動作）

import express from "express";
import crypto from "crypto";
import axios from "axios";
import { Redis } from "@upstash/redis";

// ------------------------------------------------------------
// 環境変数（名称ゆらぎに両対応）
// ------------------------------------------------------------
const {
  PORT = 3000,
  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_ACCESS_TOKEN, // 別名対応
  STORES_API_KEY,
  STORES_SHOP_ID,
  STORES_API_BASE, // 任意（未設定ならデフォルト）
  ONE_SHOT_PRODUCT_ID,
  MONTHLY_PRODUCT_ID,
  UPSTASH_REDIS_URL,
  UPSTASH_REDIS_TOKEN,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
} = process.env;

// LINEトークン（どちらでも）
const LINE_TOKEN = LINE_CHANNEL_ACCESS_TOKEN || LINE_ACCESS_TOKEN;
// Upstash（REST/通常どちらでも）
const REDIS_URL = UPSTASH_REDIS_URL || UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = UPSTASH_REDIS_TOKEN || UPSTASH_REDIS_REST_TOKEN;
// STORES API Base（将来の変更に備え）
const STORES_BASE = (STORES_API_BASE || "https://api.stores.jp").replace(/\/$/, "");

// 環境変数チェック（ログのみ）
if (!LINE_CHANNEL_SECRET || !LINE_TOKEN) console.error("LINEの環境変数が未設定です");
if (!STORES_API_KEY || !STORES_SHOP_ID) console.error("STORESの環境変数が未設定です");
if (!REDIS_URL || !REDIS_TOKEN) console.error("Upstash Redisの環境変数が未設定です");

const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
const app = express();
app.use(express.json({ verify: (req, _res, buf) => (req.rawBody = buf) }));

// ------------------------------------------------------------
// 署名検証
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
// STORES: 注文取得 & 決済確認
// ------------------------------------------------------------
async function fetchStoresOrder(orderIdOrNumber) {
  // STORESの仕様差異を吸収するフェイルオーバー実装
  // 1) /v1/shops/{shop}/orders/{order_id}
  // 2) /v1/shops/{shop}/orders?order_number={number}
  // ※ shop は "beauty-one" のようなサブドメイン名を想定（httpsや.stores.jpは含めない）

  const shop = encodeURIComponent(STORES_SHOP_ID);
  const base = STORES_BASE;
  const headers = { Authorization: `Bearer ${STORES_API_KEY}`, "Content-Type": "application/json" };

  // まずは /orders/{id} を試す
  const byIdUrl = `${base}/v1/shops/${shop}/orders/${encodeURIComponent(orderIdOrNumber)}`;
  try {
    const { data } = await axios.get(byIdUrl, { headers, timeout: 15000 });
    return data;
  } catch (e) {
    const code = e?.response?.status;
    if (code !== 404) throw e;
  }

  // 404 の場合は order_number 検索にフォールバック
  const byNumberUrl = `${base}/v1/shops/${shop}/orders?order_number=${encodeURIComponent(orderIdOrNumber)}`;
  const { data } = await axios.get(byNumberUrl, { headers, timeout: 15000 });
  // 検索APIは配列で返る場合を想定
  if (Array.isArray(data?.orders) && data.orders.length > 0) return data.orders[0];
  if (Array.isArray(data) && data.length > 0) return data[0];
  // 何も見つからず → 404相当のエラーを投げる
  const err = new Error("Order not found");
  err.status = 404;
  err.endpointTried = { byIdUrl, byNumberUrl };
  throw err;
}

async function verifyPayment(orderId) {
  const order = await fetchStoresOrder(orderId);
  return { ok: !!order && (order.status === "paid" || order.status === "captured"), order };
}(orderId) {
  const order = await fetchStoresOrder(orderId);
  return { ok: !!order && (order.status === "paid" || order.status === "captured"), order };
}

function extractPurchasedSkus(order) {
  const items = order?.line_items || [];
  // product_id or sku or handle のいずれかを優先的に使う
  return items
    .map((li) => li.product_id || li.sku || li.handle)
    .filter(Boolean);
}

function detectPlanType(purchasedSkus) {
  // 明示IDで判定（価格改定の影響を受けない）
  if (ONE_SHOT_PRODUCT_ID && purchasedSkus.includes(ONE_SHOT_PRODUCT_ID)) return "one_shot";
  if (MONTHLY_PRODUCT_ID && purchasedSkus.includes(MONTHLY_PRODUCT_ID)) return "monthly";
  // デフォルトは単発扱い（安全策）
  return "one_shot";
}

// ------------------------------------------------------------
// Redis Key設計
// ------------------------------------------------------------
const usedOrderKey = (orderId) => `used_order:${orderId}`; // 使い切りフラグ
const entitlementKey = (userId) => `entitlement:${userId}`; // 現在の権利

// ------------------------------------------------------------
// LINE返信
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// Webhook（即200でタイムアウト回避 → 非同期処理）
// ------------------------------------------------------------
app.post("/webhook", async (req, res) => {
  res.status(200).end(); // LINE検証・本番どちらでもタイムアウト回避

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
        await handleOrderRegistrationFlow({ replyToken, userId, orderId: orderIdCandidate });
      } else {
        await handleQuestionFlow({ replyToken, userId, question: text });
      }
    }
  } catch (e) {
    console.error("Webhook処理エラー", e);
  }
});

// ------------------------------------------------------------
// 注文番号抽出（要件にあわせて調整可）
// ------------------------------------------------------------
function parseOrderId(text) {
  // 例: 連番 or "ST"で始まる英数字
  const m = text.match(/\b(ST[\w-]+|\d{6,})\b/i);
  return m ? m[1] : null;
}

// ------------------------------------------------------------
// 注文登録フロー
// ------------------------------------------------------------
async function handleOrderRegistrationFlow({ replyToken, userId, orderId }) {
  try {
    // 既に使い切り済みの注文か
    const isUsed = await redis.get(usedOrderKey(orderId));
    if (isUsed) {
      await replyText(
        replyToken,
        `この注文番号(${orderId})は既に鑑定に使用されています。\n引き続きご相談いただくには、新しいご注文をお願いします。`
      );
      return;
    }

    // 決済確認
    const { ok, order } = await verifyPayment(orderId);
    if (!ok) {
      await replyText(replyToken, "未決済のため注文を承認できません。決済完了後にもう一度お送りください。");
      return;
    }

    // プラン判定
    const skus = extractPurchasedSkus(order);
    const planType = detectPlanType(skus);

    // 権利付与（90日キャッシュ。月額はexpiresAt例示）
    const ent = { type: planType, orderId, used: false, grantedAt: Date.now() };
    if (planType === "monthly") ent.expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 例: 30日

    await redis.set(entitlementKey(userId), ent, { ex: 60 * 60 * 24 * 90 });

    await replyText(
      replyToken,
      planType === "one_shot"
        ? `注文番号(${orderId})を確認しました。\nこのご注文は「1回のみ」プランです。次のメッセージからご質問を1回だけ送ってください。`
        : `注文番号(${orderId})を確認しました。\n回数制限なしのプランとして登録しました。ご質問をお送りください。`
    );
  } catch (e) {
    console.error("注文登録エラー", e?.response?.data || e.message);
    await replyText(replyToken, "注文確認でエラーが発生しました。時間をおいて再度お試しください。");
  }
}

// ------------------------------------------------------------
// 質問フロー（権利チェック → 回答 → 使い切り処理）
// ------------------------------------------------------------
async function handleQuestionFlow({ replyToken, userId, question }) {
  const ent = await redis.get(entitlementKey(userId));

  if (!ent) {
    await replyText(replyToken, "ご購入の確認が必要です。まずは注文番号をメッセージで送ってください。\n例）ST123456 または 123456");
    return;
  }

  if (ent.expiresAt && Date.now() > ent.expiresAt) {
    await replyText(replyToken, "ご契約の有効期限が切れています。再度ご購入ください。");
    return;
  }

  if (ent.type === "one_shot") {
    const alreadyUsed = (await redis.get(usedOrderKey(ent.orderId))) || ent.used;
    if (alreadyUsed) {
      await replyText(replyToken, "この注文ではすでに鑑定済みです。再度のご利用は新規ご注文をお願いします。");
      return;
    }

    // 回答
    const answer = await generateFortune(question);
    await replyText(replyToken, answer);

    // 使い切り登録（グローバル & ユーザー権利）
    await redis.set(usedOrderKey(ent.orderId), "true", { ex: 60 * 60 * 24 * 365 });
    ent.used = true;
    await redis.set(entitlementKey(userId), ent, { ex: 60 * 60 * 24 * 365 });

    await replyText(replyToken, "鑑定は以上です。引き続きご相談いただく場合は、再度のご購入をお願いいたします。");
    return;
  }

  // 月額など回数無制限
  const answer = await generateFortune(question);
  await replyText(replyToken, answer);
}

// ------------------------------------------------------------
// ダミー鑑定（実装済みの推論/占い関数に差し替え）
// ------------------------------------------------------------
async function generateFortune(q) {
  return `【鑑定結果】\nご相談: ${q}\n\n今は落ち着いて状況整理を。小さな一歩が大きな変化に繋がります✨`;
}

// ------------------------------------------------------------
app.listen(PORT, () => console.log(`LISTEN: http://0.0.0.0:${PORT}`));
