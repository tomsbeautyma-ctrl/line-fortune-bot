// index.js — STORES 550円「1回のみ」プランの“1回きり”制御（再購入で再度OK）対応・完全版
// ------------------------------------------------------------
// ✅ できること
// 1) STORESの決済確認（Paidのみ許可）
// 2) 550円ワンショット（単発）プランは「1注文=1回答」で完全にロック
// 3) 月額などの継続プランは回数制限なし
// 4) 再購入（新しい注文番号）なら再度質問OK
// 5) Redis(Upstash)に「使用済み注文」を保存して二度使いを防止
// 6) ユーザーは最初に注文番号を送る→承認→以降の質問に回答
// ------------------------------------------------------------

import express from "express";
import crypto from "crypto";
import axios from "axios";
import { Redis } from "@upstash/redis";

// -------------------------
// 環境変数
// -------------------------
const {
  PORT = 3000,
  // LINE
  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  // STORES
  STORES_API_KEY,
  STORES_SHOP_ID,
  // 商品判定（必ずSTORESの実商品ID/ハンドル/識別子に合わせて設定）
  ONE_SHOT_PRODUCT_ID, // 例: "prod_550_single"（550円・1回のみ）
  MONTHLY_PRODUCT_ID,  // 例: "prod_monthly_3000"（回数無制限）
  // Upstash Redis
  UPSTASH_REDIS_URL,
  UPSTASH_REDIS_TOKEN,
} = process.env;

if (!LINE_CHANNEL_SECRET || !LINE_CHANNEL_ACCESS_TOKEN) {
  console.error("LINEの環境変数が未設定です");
}
if (!STORES_API_KEY || !STORES_SHOP_ID) {
  console.error("STORESの環境変数が未設定です");
}
if (!UPSTASH_REDIS_URL || !UPSTASH_REDIS_TOKEN) {
  console.error("Upstash Redisの環境変数が未設定です");
}

const redis = new Redis({ url: UPSTASH_REDIS_URL, token: UPSTASH_REDIS_TOKEN });
const app = express();
app.use(express.json({ verify: rawBodySaver }));

function rawBodySaver(req, res, buf) {
  req.rawBody = buf;
}

// -------------------------
// LINE 署名検証
// -------------------------
function validateLineSignature(req) {
  const signature = req.headers["x-line-signature"];
  if (!signature) return false;
  const hmac = crypto.createHmac("SHA256", LINE_CHANNEL_SECRET);
  hmac.update(req.rawBody);
  const expected = hmac.digest("base64");
  return signature === expected;
}

// -------------------------
// STORES: 注文取得（必要に応じて既存の実装に差し替え）
// 備考) STORESのエンドポイントや認証はご利用環境に合わせて調整してください。
//       ここでは“概念実装”として書いています。
// -------------------------
async function fetchStoresOrder(orderId) {
  // 例: GET https://api.stores.jp/v1/shops/{shop_id}/orders/{order_id}
  // 実際のエンドポイント/レスポンスはSTORESのAPI仕様に合わせてください。
  const url = `https://api.stores.jp/v1/shops/${encodeURIComponent(
    STORES_SHOP_ID
  )}/orders/${encodeURIComponent(orderId)}`;

  const { data } = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${STORES_API_KEY}`,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });
  return data; // { status: 'paid', line_items: [{product_id, quantity, ...}], ... }
}

async function verifyPayment(orderId) {
  const order = await fetchStoresOrder(orderId);
  // paid / authorized など、ご利用の与信フローに合わせて判定
  return order && (order.status === "paid" || order.status === "captured");
}

function extractPurchasedSkus(order) {
  // line_items から商品IDやSKUを抽出（STORESのレスポンスに合わせて修正）
  const items = order?.line_items || [];
  return items.map((li) => li.product_id || li.sku || li.handle).filter(Boolean);
}

function detectPlanType(purchasedSkus) {
  // ONE_SHOT_PRODUCT_IDに該当 → 単発
  if (ONE_SHOT_PRODUCT_ID && purchasedSkus.includes(ONE_SHOT_PRODUCT_ID)) {
    return "one_shot";
  }
  // MONTHLY_PRODUCT_IDに該当 → 継続
  if (MONTHLY_PRODUCT_ID && purchasedSkus.includes(MONTHLY_PRODUCT_ID)) {
    return "monthly";
  }
  // どれにも該当しない場合は単発として処理する or 拒否する
  return "one_shot";
}

// -------------------------
// Redis Key 設計
// -------------------------
// 注文使用済みフラグ: used_order:{orderId} -> "true"
// ユーザーのアクティブ権利: entitlement:{lineUserId} -> {
//   type: 'one_shot'|'monthly',
//   orderId: 'xxxxx',
//   used: boolean,
//   expiresAt?: timestamp
// }

function usedOrderKey(orderId) {
  return `used_order:${orderId}`;
}
function entitlementKey(userId) {
  return `entitlement:${userId}`;
}

// -------------------------
// LINE 返信ユーティリティ
// -------------------------
async function replyText(replyToken, text) {
  try {
    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      {
        replyToken,
        messages: [{ type: "text", text }],
      },
      {
        headers: {
          Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (e) {
    console.error("LINE返信エラー", e?.response?.data || e.message);
  }
}

// -------------------------
// メインロジック
// -------------------------
app.post("/webhook", async (req, res) => {
  if (!validateLineSignature(req)) {
    return res.status(403).send("Invalid signature");
  }

  const events = req.body?.events || [];
  res.status(200).end(); // 先に応答

  for (const ev of events) {
    try {
      if (ev.type !== "message" || ev.message.type !== "text") continue;

      const userId = ev.source?.userId;
      const text = (ev.message.text || "").trim();
      const replyToken = ev.replyToken;

      // 1) ユーザーが注文番号を送ってきたかを先にチェック（数字やSTで始まるIDなどを許可）
      const orderIdCandidate = parseOrderId(text);
      if (orderIdCandidate) {
        await handleOrderRegistrationFlow({ replyToken, userId, orderId: orderIdCandidate });
        continue;
      }

      // 2) 質問フロー（権利チェック）
      await handleQuestionFlow({ replyToken, userId, question: text });
    } catch (err) {
      console.error("イベント処理中エラー", err);
    }
  }
});

// -------------------------
// 注文番号らしき文字列抽出（必要に応じて厳密化）
// -------------------------
function parseOrderId(text) {
  // 例: 純数字、または "ST" で始まる英数を注文番号とみなす
  // 実際の仕様に合わせて正規表現を調整してください
  const m = text.match(/\b(ST[\w-]+|\d{6,})\b/i);
  return m ? m[1] : null;
}

// -------------------------
// 注文登録フロー
// -------------------------
async function handleOrderRegistrationFlow({ replyToken, userId, orderId }) {
  try {
    // 既にこの注文が使用済みかチェック（悪用＆二重登録防止）
    const isUsed = await redis.get(usedOrderKey(orderId));
    if (isUsed) {
      await replyText(
        replyToken,
        `この注文番号(${orderId})は既に鑑定に使用されています。\n再度ご利用いただくには、新しいご注文をお願いします。`
      );
      return;
    }

    // 決済確認
    const paid = await verifyPayment(orderId);
    if (!paid) {
      await replyText(replyToken, "未決済のため注文を承認できません。決済完了後にもう一度お送りください。");
      return;
    }

    // 商品判定
    const order = await fetchStoresOrder(orderId);
    const skus = extractPurchasedSkus(order);
    const planType = detectPlanType(skus);

    // ユーザーに権利を付与
    const ent = { type: planType, orderId, used: false, grantedAt: Date.now() };

    // 月額プランなどの場合、任意で期限管理を入れる
    if (planType === "monthly") {
      // 例: 30日有効（STORES側のサブスク継続判定が可能ならそれに置き換え）
      ent.expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    }

    await redis.set(entitlementKey(userId), ent, { ex: 60 * 60 * 24 * 90 }); // 90日で自然掃除

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

// -------------------------
// 質問フロー（権利チェック → 回答 → 使用済み化）
// -------------------------
async function handleQuestionFlow({ replyToken, userId, question }) {
  // 1) 権利取得
  const ent = await redis.get(entitlementKey(userId));
  if (!ent) {
    await replyText(
      replyToken,
      "ご購入の確認が必要です。まずは注文番号をメッセージで送ってください。\n例）ST123456 または 123456"
    );
    return;
  }

  // 2) 期限切れチェック（任意）
  if (ent.expiresAt && Date.now() > ent.expiresAt) {
    await replyText(replyToken, "ご契約の有効期限が切れています。再度ご購入ください。");
    return;
  }

  // 3) プラン種別ごとの制御
  if (ent.type === "one_shot") {
    // 注文の“使用済み” or ユーザーエンタイトルメントが used=true か確認
    const alreadyUsedGlobally = await redis.get(usedOrderKey(ent.orderId));
    if (alreadyUsedGlobally || ent.used) {
      await replyText(
        replyToken,
        "この注文ではすでに鑑定済みです。再度ご利用いただくには、新しいご注文をお願いします。"
      );
      return;
    }

    // ここで実回答（占い・QAなど）
    const answer = await generateFortune(question);

    // 回答送信
    await replyText(replyToken, answer);

    // 使用済み登録（グローバル + ユーザー側）
    await redis.set(usedOrderKey(ent.orderId), "true", { ex: 60 * 60 * 24 * 365 });
    ent.used = true;
    await redis.set(entitlementKey(userId), ent, { ex: 60 * 60 * 24 * 365 });

    // 使い切り後の案内
    await replyText(
      replyToken,
      "鑑定は以上です。引き続きご相談いただく場合は、再度のご購入をお願いいたします。"
    );
    return;
  }

  // 継続プラン（回数制限なし）
  // ここで実回答
  const answer = await generateFortune(question);
  await replyText(replyToken, answer);
}

// -------------------------
// ダミー鑑定ロジック（実装済みの推論/占い関数に差し替え）
// -------------------------
async function generateFortune(question) {
  // ここを既存のOpenAI/DeepInfra等の推論関数に繋ぎこむ
  // 回答の前置きは自由に調整してください
  return `【鑑定結果】\nご相談: ${question}\n\n今回のポイントは、\n1) 現状の整理\n2) 選択肢の明確化\n3) 直近の一歩の決定\nの3点です。\n\n追加の深掘りは、再購入後に承ります。`;
}

// -------------------------
// ヘルスチェック
// -------------------------
app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`LISTEN: http://0.0.0.0:${PORT}`);
});
