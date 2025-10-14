// index.js — 本番用: STORES決済チェック + 550円(1回) + 1650円(24h) + 3300円(サブスク常時認証)
// - 環境変数ゆらぎ対応（LINE/Redis/STORES）
// - LINE検証タイムアウト回避
// - 購入未済の際の誘導メッセージ
// - サブスクは毎質問ごとにSTORESへ照会して解約/返金時は即停止
// - 24hパスは自動期限切れ、1回プランは使い切りロック
// - OpenAIは簡易実装（必要に応じてプロンプトや温度等を調整）

import express from "express";
import crypto from "crypto";
import axios from "axios";
import { Redis } from "@upstash/redis";

// ------------------------------------------------------------
// 環境変数
// ------------------------------------------------------------
const {
  PORT = 3000,

  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_ACCESS_TOKEN, // 別名サポート

  // STORES 認証（Bearerの名称ゆらぎ対応）
  STORES_API_KEY,
  STORES_BEARER,
  STORES_SHOP_ID,           // 例: "beauty-one"（サブドメインのみ）
  STORES_API_BASE,          // 省略可: 既定 https://api.stores.jp
  STORES_SHOP_URL,          // 未購入時の誘導先（任意。例: https://beauty-one.stores.jp）

  // 商品ID（product_id / sku / handle のいずれかでOK）
  ONE_SHOT_PRODUCT_ID,      // 550円: 1回のみ
  DAYPASS_PRODUCT_ID,       // 1650円: 24時間
  SUBSCRIPTION_PRODUCT_ID,  // 3300円: サブスク（定期）

  // OpenAI
  OPENAI_API_KEY,
  MODEL = "gpt-4o-mini",    // 任意

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

// ログだけ出す（起動は継続）
if (!LINE_CHANNEL_SECRET || !LINE_TOKEN) console.error("[warn] LINE env 未設定");
if (!STORES_AUTH || !STORES_SHOP_ID) console.error("[warn] STORES env 未設定");
if (!REDIS_URL || !REDIS_TOKEN) console.error("[warn] Upstash env 未設定");
if (!OPENAI_API_KEY) console.error("[warn] OPENAI_API_KEY 未設定");

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
// ヘルス/疎通
// ------------------------------------------------------------
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get("/webhook", (_req, res) => res.status(200).send("OK"));

// ------------------------------------------------------------
// STORES: 注文取得（ID/注文番号 両対応）
// ------------------------------------------------------------
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

// 「支払いOK」かをざっくり判定（キャンセル/返金はNG）
function isPaid(order) {
  const st = (order?.status || "").toLowerCase();
  // STORESの代表的な状態名を想定
  const ok = ["paid", "captured", "shipped", "fulfilled"].includes(st);
  const ng  = ["canceled", "cancelled", "refunded"].includes(st);
  return ok && !ng;
}

async function verifyPayment(orderId) {
  const order = await fetchStoresOrder(orderId);
  return { ok: isPaid(order), order };
}

// ラインアイテムから product_id/sku/handle を抜く
function extractPurchasedSkus(order) {
  const items = order?.line_items || [];
  return items.map(li => li.product_id || li.sku || li.handle).filter(Boolean);
}

// プラン判定（商品IDで厳密化）
function detectPlanType(purchasedSkus) {
  if (ONE_SHOT_PRODUCT_ID && purchasedSkus.includes(ONE_SHOT_PRODUCT_ID)) return "one_shot";
  if (DAYPASS_PRODUCT_ID  && purchasedSkus.includes(DAYPASS_PRODUCT_ID))  return "day_pass";
  if (SUBSCRIPTION_PRODUCT_ID && purchasedSkus.includes(SUBSCRIPTION_PRODUCT_ID)) return "subscription";
  // デフォルトは安全側で1回扱い
  return "one_shot";
}

// ------------------------------------------------------------
// Redis Keys
// ------------------------------------------------------------
const usedOrderKey   = (orderId) => `used_order:${orderId}`;      // 1回プランで使用済みフラグ
const entitlementKey = (userId)  => `entitlement:${userId}`;      // 現在の権利（type, orderId, expiresAt など）
const lastSeenPlan   = (userId)  => `last_plan:${userId}`;        // 誘導メッセージ出し分けに使用（任意）

// ------------------------------------------------------------
// LINE 返信
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

// 未購入時の誘導文
function purchaseGuide() {
  const url = STORES_SHOP_URL || "STORESのショップ";
  return [
    "ご利用にはご購入・認証が必要です。",
    "① 550円: 1回のみ質問可",
    "② 1,650円: 24時間質問し放題",
    "③ 3,300円: 月額質問し放題（解約まで）",
    "",
    `ご購入後は「注文番号」をこのトークに送ってください。`,
    `ショップ: ${url}`
  ].join("\n");
}

// ------------------------------------------------------------
// Webhook（即200でLINEのタイムアウト回避）
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
// 注文番号抽出（「認証 123456」「ST1234」などに反応）
// ------------------------------------------------------------
function parseOrderId(text) {
  // 「認証」「注文」「order」等の語が付いていてもOKにする
  const m = text.match(/\b(?:認証|注文|order)?\s*(ST[\w-]+|\d{6,})\b/i);
  return m ? m[1] : null;
}

// ------------------------------------------------------------
// 注文登録フロー
// ------------------------------------------------------------
async function handleOrderRegistrationFlow({ replyToken, userId, orderId }) {
  try {
    // 既に使われた注文？
    const isUsed = await redis.get(usedOrderKey(orderId));
    if (isUsed) {
      await replyText(
        replyToken,
        `この注文番号(${orderId})は既に鑑定に使用されています。\n引き続きご相談いただくには、新しいご注文をお願いします。`
      );
      return;
    }

    const { ok, order } = await verifyPayment(orderId);
    if (!ok) {
      await replyText(replyToken, "未決済 / もしくはキャンセル・返金のため承認できません。決済完了後にもう一度お送りください。");
      return;
    }

    const skus = extractPurchasedSkus(order);
    const planType = detectPlanType(skus);

    const ent = { type: planType, orderId, grantedAt: Date.now(), used: false };

    // 24時間パス
    if (planType === "day_pass") {
      ent.expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    }
    // サブスク：期限は持たず、毎回STORESに照会する
    // 1回のみ：used=false のまま保存

    // 保存（安全に長めにキャッシュ）
    await redis.set(entitlementKey(userId), ent, { ex: 60 * 60 * 24 * 90 });
    await redis.set(lastSeenPlan(userId), planType, { ex: 60 * 60 * 24 * 7 });

    const msg =
      planType === "one_shot"
        ? `注文番号(${orderId})を確認しました。\nこのご注文は「1回のみ」プランです。次のメッセージでご質問を1回だけ送ってください。`
        : planType === "day_pass"
        ? `注文番号(${orderId})を確認しました。\nこのご注文は「24時間質問し放題」プランです。有効期限内は自由にご質問ください。`
        : `注文番号(${orderId})を確認しました。\nこのご注文は「月額サブスクリプション」プランです。ご質問をどうぞ。`;

    await replyText(replyToken, msg);
  } catch (e) {
    console.error("注文登録エラー", e?.response?.data || e.message);
    await replyText(replyToken, "注文確認でエラーが発生しました。時間をおいて再度お試しください。");
  }
}

// ------------------------------------------------------------
// 質問フロー（権利確認 → 回答 → 必要に応じて使用/期限処理）
// ------------------------------------------------------------
async function handleQuestionFlow({ replyToken, userId, question }) {
  const ent = await redis.get(entitlementKey(userId));

  if (!ent) {
    await replyText(replyToken, purchaseGuide());
    return;
  }

  // 期限チェック（24hパス）
  if (ent.expiresAt && Date.now() > ent.expiresAt) {
    await replyText(replyToken, "有効期限が切れました。再度ご購入ください。\n" + purchaseGuide());
    return;
  }

  // サブスクは毎回STORESへ状態照会して、解約/返金を即時反映
  if (ent.type === "subscription") {
    try {
      const { ok } = await verifyPayment(ent.orderId);
      if (!ok) {
        await replyText(replyToken, "サブスクリプションが無効になっています。再度ご購入・再開の上でご利用ください。\n" + purchaseGuide());
        return;
      }
    } catch (e) {
      console.error("サブスク確認エラー", e?.response?.data || e.message);
      // 確認不能時は安全側でブロック
      await replyText(replyToken, "現在サブスクリプション状態を確認できませんでした。しばらくしてから再度お試しください。");
      return;
    }
  }

  // 1回プラン：未使用か？
  if (ent.type === "one_shot") {
    const alreadyUsed = (await redis.get(usedOrderKey(ent.orderId))) || ent.used;
    if (alreadyUsed) {
      await replyText(replyToken, "この注文では既に鑑定済みです。続けてご相談の際は新規ご購入をお願いします。\n" + purchaseGuide());
      return;
    }
  }

  // ====== ここで回答生成 ======
  const answer = await generateFortune(question);
  await replyText(replyToken, answer);

  // 使用/期限処理
  if (ent.type === "one_shot") {
    await redis.set(usedOrderKey(ent.orderId), "true", { ex: 60 * 60 * 24 * 365 });
    ent.used = true;
    await redis.set(entitlementKey(userId), ent, { ex: 60 * 60 * 24 * 365 });
    await replyText(replyToken, "鑑定は以上です。引き続きのご相談は新しいご注文をお願いします。");
  } else if (ent.type === "day_pass") {
    const remains = Math.max(0, ent.expiresAt - Date.now());
    const hours = Math.ceil(remains / (60 * 60 * 1000));
    await replyText(replyToken, `ご利用中の24時間パスは約${hours}時間で期限切れになります。`);
  }
}

// ------------------------------------------------------------
// OpenAI（簡易）
// ------------------------------------------------------------
async function generateFortune(q) {
  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: MODEL,
        messages: [
          { role: "system", content: "あなたは思いやりのある占い師です。簡潔で前向きな助言を返してください。" },
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
  // フォールバック
  return `【占い結果】\nご相談: ${q}\n\n今は落ち着いて状況整理を。小さな一歩が大きな変化に繋がります✨`;
}

// ------------------------------------------------------------
app.listen(PORT, () => console.log(`LISTEN: http://0.0.0.0:${PORT}`));
