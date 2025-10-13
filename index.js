// index.js — STORES購入者認証 + OpenAI占い（フル機能・2025-10-13）

import express from "express";
import fetch from "node-fetch";
import dayjs from "dayjs";
import { Client, middleware } from "@line/bot-sdk";

/* ========= 必須環境変数 =========
LINE_ACCESS_TOKEN, LINE_CHANNEL_SECRET
OPENAI_API_KEY, MODEL (例: gpt-4o-mini)

STORES_API_BASE  例: https://api.stores.dev/retail/202211
STORES_API_KEY   （Bearer の中身。先頭に Bearer は付けない）

REDIS_URL (Upstash REST URL), REDIS_TOKEN (REST TOKEN)
STORE_URL  （購入導線の案内用URL）
PORT       （Renderは 10000 を推奨）
================================= */

const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const MODEL = process.env.MODEL || "gpt-4o-mini";
const STORE_URL = process.env.STORE_URL || "https://beauty-one.stores.jp";

// ★STORESは .dev/retail/202211 を既定に
const STORES_API_BASE = (process.env.STORES_API_BASE || "https://api.stores.dev/retail/202211").replace(/\/$/, "");
const STORES_API_KEY  = process.env.STORES_API_KEY || "";

const REDIS_URL   = process.env.REDIS_URL || "";
const REDIS_TOKEN = process.env.REDIS_TOKEN || "";

const app = express();
const client = new Client(config);

// ========= Redis（Upstash REST） =========
async function kvGet(key){
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  if (!r.ok) return null;
  const j = await r.json(); return j?.result ?? null;
}
async function kvSet(key, val){
  if (!REDIS_URL || !REDIS_TOKEN) return;
  await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(val)}`, {
    method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
}
async function kvDel(key){
  if (!REDIS_URL || !REDIS_TOKEN) return;
  await fetch(`${REDIS_URL}/del/${encodeURIComponent(key)}`, {
    method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
}

// ========= 文言 =========
const PURCHASE_ONLY_MESSAGE =
`🔒 この占いサービスはご購入者限定です

Beauty Oneの公式ストアでプランをご購入後、
購入完了画面に表示の【注文番号】を
このLINEに「認証 注文番号」の形式で送信してください。

🪄 プラン一覧
・お試し鑑定（1購入=1質問）¥500
・1日無制限チャット占い ¥1,500（当日23:59まで）
・定期鑑定（月額）¥3,000

🔗 ご購入はこちら 👉 ${STORE_URL}`;

const TRIAL_REPURCHASE_MSG =
  "お試し鑑定は 1購入につき1質問です。再度ご利用の際は再購入をお願いします。";

// ========= プラン =========
const PLAN = { NONE:"none", TRIAL:"trial", UNLIMITED:"unlimited", MONTHLY:"monthly" };
const endOfTodayTs = () => dayjs().endOf("day").valueOf();

// ========= ヘルス系 =========
app.get("/health", (_,res)=>res.status(200).send("healthy"));
app.get("/",       (_,res)=>res.status(200).send("OK"));
app.get("/env",    (req,res)=>{
  const OPENAI = !!process.env.OPENAI_API_KEY;
  res.status(200).json({ MODEL, OPENAI, STORE_URL, STORES_API_BASE, REDIS: !!REDIS_URL });
});
app.get("/ping-llm", async (_, res) => {
  try {
    const msg = await generateWithOpenAI("テスト鑑定を一文で。", []);
    res.status(200).send(msg ? `LLM ok: ${msg.slice(0,60)}` : "LLM fallback");
  } catch(e){ res.status(500).send("LLM error: " + (e.message||e)); }
});

// ========= Webhook =========
app.post("/webhook", middleware(config), async (req, res) => {
  try {
    const events = req.body?.events ?? [];
    await Promise.all(events.map(handleEvent));
    res.sendStatus(200);
  } catch(e) {
    console.error("webhook error:", e);
    res.sendStatus(500);
  }
});

async function handleEvent(event){
  if (event.type !== "message" || event.message.type !== "text") return;
  const userId = event.source.userId;
  const text = (event.message.text || "").trim();

  // メニュー/リセット
  if (["メニュー","/menu","menu","help","？","?"].includes(text)) {
    return reply(event, `使い方：\n1) ストアで購入 → 注文番号を取得\n2) LINEで「認証 1234ABCD」\n3) 有効化後にご相談内容を送信\n\n🔗 購入：${STORE_URL}`);
  }
  if (["リセット","/reset","reset"].includes(text)) {
    await kvDel(`sess:${userId}`);
    return reply(event, "会話履歴をリセットしました。ご相談内容をどうぞ。");
  }

  // ========== 認証：「認証 <注文番号>」 ==========
  const auth = text.match(/^(?:認証|認識|注文|コード|order)\s+([A-Za-z0-9\-_]{5,})$/i);
  const justOrder = !auth && text.match(/^([A-Za-z0-9\-_]{6,})$/);
  if (justOrder) {
    return reply(event, `ご購入ありがとうございます。\n認証の形式で送ってください：\n例）認証 ${justOrder[1]}`);
  }

  if (auth) {
    const orderNo = auth[1];
    console.log(`🟡 [AUTH try] 注文番号: ${orderNo} BASE: ${STORES_API_BASE}`);

    const used = await kvGet(`order:used:${orderNo}`);
    if (used === "1") return reply(event, "この注文番号はすでに使用済みです。");

    const order = await fetchStoresOrder(orderNo);
    if (!order) return reply(event, "購入が確認できませんでした。注文番号をご確認ください。");
    if (!isPaid(order)) return reply(event, "お支払い未確認です。決済完了後に再度お試しください。");
console.log("🧾 order structure sample:", JSON.stringify(order, null, 2).slice(0, 2000));

    const plan = inferPlan(order);
    if (!plan) return reply(event, "商品が特定できませんでした。サポートまでご連絡ください。");

    await kvSet(`user:plan:${userId}`, JSON.stringify(plan));
    await kvSet(`order:used:${orderNo}`, "1");

    const planName = plan.type===PLAN.TRIAL ? "お試し（1購入=1質問）"
                    : plan.type===PLAN.UNLIMITED ? "1日無制限（当日23:59まで）"
                    : "月額定期";
    return reply(event, `✅ 購入を確認しました。${planName}を有効化しました。\nご相談内容を送信してください。`);
  }

  // ========== 利用権チェック ==========
  const stRaw = await kvGet(`user:plan:${userId}`);
  if (!stRaw) return reply(event, PURCHASE_ONLY_MESSAGE);
  const st = JSON.parse(stRaw);

  // 期限切れ
  if (st.expireAt && Date.now() > st.expireAt) {
    await kvDel(`user:plan:${userId}`);
    return reply(event, "プランの有効期限が切れました。\n" + PURCHASE_ONLY_MESSAGE);
  }

  // お試し：1購入=1回答ガード
  if (st.type === PLAN.TRIAL) {
    const isCommand = ["メニュー","/menu","menu","help","？","?","リセット","/reset","reset","認証","認識","注文","order","コード"]
      .some(k => text.includes(k));
    const consumedKey = `trial:consumed:${userId}:${st.orderId}`;
    const consumed = await kvGet(consumedKey);
    if (consumed === "1") return reply(event, TRIAL_REPURCHASE_MSG);
    if (isCommand) return reply(event, "お試しは1購入につき1質問です。占いたい内容を1つだけ送ってください。");
  }

  // ========== 鑑定（OpenAI） ==========
  const hist = await loadSession(userId);
  hist.push({ role:"user", content:text });
  while (hist.length > 10) hist.shift();

  const name = await safeName(userId);
  const prompt = buildPrompt(name, hist);
  const answer = await generateWithOpenAI(prompt, hist) || fallbackReply();

  hist.push({ role:"assistant", content:answer });
  await saveSession(userId, hist);

  // お試しなら“消費”マーク
  if (st.type === PLAN.TRIAL) {
    await kvSet(`trial:consumed:${userId}:${st.orderId}`,"1");
  }
  return reply(event, answer.slice(0, 4900));
}

// ========= セッション保存 =========
async function loadSession(userId){
  const raw = await kvGet(`sess:${userId}`);
  return raw ? JSON.parse(raw) : [];
}
async function saveSession(userId, hist){
  await kvSet(`sess:${userId}`, JSON.stringify(hist.slice(-10)));
}

// ========= STORES API（詳細取得つき） =========
async function fetchStoresOrder(orderNumber) {
  if (!STORES_API_KEY) { console.log("❌ STORES_API_KEY 未設定"); return null; }

  const headers = { Authorization: `Bearer ${STORES_API_KEY}`, Accept: "application/json" };
  const q = encodeURIComponent(String(orderNumber));

  // 1) 番号で一覧ヒット
  const listUrl = `${STORES_API_BASE}/orders?numbers=${q}`;
  console.log("➡️ fetch(list):", listUrl);
  const listRes = await fetch(listUrl, { headers });
  const listTxt = await listRes.text();
  if (!listRes.ok) {
    console.log("⚠️ STORES応答(list):", listRes.status, listUrl, listTxt.slice(0,150));
    return null;
  }
  let list;
  try { list = JSON.parse(listTxt); } catch { list = null; }
  const hit = list?.orders?.find(o => String(o.number||o.order_number) === String(orderNumber));
  if (!hit) { console.log("❌ 注文が見つかりません:", orderNumber); return null; }

  const orderId = hit.id || hit.order_id || hit.number || hit.order_number;
  console.log("✅ 注文番号ヒット:", orderNumber, "→ id:", orderId);

  // 2) IDで詳細取得（ここに payments/transactions が入る想定）
  const detailUrl = `${STORES_API_BASE}/orders/${encodeURIComponent(String(orderId))}`;
  console.log("➡️ fetch(detail):", detailUrl);
  const detRes = await fetch(detailUrl, { headers });
  const detTxt = await detRes.text();
  if (!detRes.ok) {
    console.log("⚠️ STORES応答(detail):", detRes.status, detailUrl, detTxt.slice(0,150));
    // 一覧のヒットだけでも返す（最低限の情報）
    return hit;
  }
  let detail;
  try { detail = JSON.parse(detTxt); } catch { detail = null; }

  // 3) 詳細が order 直で返る or 包装されて返る両対応
  const full = detail?.order || detail || hit;

  // デバッグ（一度だけでOKなら適宜コメントアウト）
  console.log("🧾 order keys:", Object.keys(full || {}));
  return full;
}


// ========= 支払い判定（詳細フィールド網羅） =========
function isPaid(order) {
  // トップレベル候補（あれば使う）
  const candidates = [
    String(order?.paid_status ?? ""),
    String(order?.payment_status ?? ""),
    String(order?.status ?? ""),
    String(order?.financial_status ?? ""),
  ].map(s => s.toLowerCase()).filter(Boolean);

  const flagPaid = order?.paid === true || order?.is_paid === true;

  // payments[].paid_at
  const paidAtFromPayments = Array.isArray(order?.payments)
    ? order.payments.map(p => p?.paid_at).filter(Boolean)
    : [];

  // transactions[].status / transactions[].paid_at など
  const tStatuses = Array.isArray(order?.transactions)
    ? order.transactions.flatMap(t => [
        String(t?.status ?? "").toLowerCase(),
        String(t?.result ?? "").toLowerCase(),
        String(t?.state ?? "").toLowerCase(),
      ].filter(Boolean))
    : [];

  const tPaidAt = Array.isArray(order?.transactions)
    ? order.transactions.map(t => t?.paid_at || t?.captured_at || t?.settled_at).filter(Boolean)
    : [];

  // 金額・ステータス系ヒント
  const hasPaymentAmount = typeof order?.payment_amount === "number" && order.payment_amount > 0;
  const hasReadiedAt = !!order?.readied_at; // 受注確定/支払確認後に立つケースがある

  const okWords = ["paid","authorized","captured","settled","paid_and_shipped","payment_completed","completed","succeeded","success","ok"];

  const textHit =
    candidates.some(s => okWords.some(w => s.includes(w))) ||
    tStatuses.some(s => okWords.some(w => s.includes(w)));

  const ok =
    flagPaid ||
    paidAtFromPayments.length > 0 ||
    tPaidAt.length > 0 ||
    hasPaymentAmount ||
    hasReadiedAt ||
    textHit;

  console.log("🔎 支払いフィールド:", {
    candidates, flagPaid, hasPaymentAmount, readied_at: order?.readied_at,
    payments0: Array.isArray(order?.payments) ? order.payments[0] : undefined,
    transactions0: Array.isArray(order?.transactions) ? order.transactions[0] : undefined,
  }, "→", ok ? "有効（決済済）" : "未決済");

  return ok;
}

// ========= プラン判定（多層フィールド＋金額フォールバック） =========
function inferPlan(order){
  // 1) 各所に散らばりがちな商品情報を片っ端から集める
  const arrays = [
    order?.items,
    order?.line_items,
    order?.order_items,
    order?.products,
    order?.details,
  ].filter(Array.isArray);

  const texts = [];
  const pushText = (v) => { if (!v) return; const s = String(v).trim(); if (s) texts.push(s); };

  for (const arr of arrays) {
    for (const it of arr) {
      pushText(it?.sku);
      pushText(it?.title); pushText(it?.name); pushText(it?.product_name);
      pushText(it?.variant_name); pushText(it?.option_name);
      if (it?.product) { pushText(it.product?.sku); pushText(it.product?.name); }
      if (Array.isArray(it?.files)) for (const f of it.files) pushText(f?.name);
      if (Array.isArray(it?.downloads)) for (const d of it.downloads) pushText(d?.name);
    }
  }
  const skuConcat = texts.join(" ").toUpperCase();
  console.log("📄 購入商品テキスト候補:", texts.slice(0,10)); // デバッグ用

  // 2) よくある表記をマッチ
  if (/\bTRIAL-500\b/.test(skuConcat) || /お試し|TRIAL|体験/.test(skuConcat) || /BEAUTYONE_CHAT_TRIAL/i.test(skuConcat)) {
    return { type: PLAN.TRIAL, orderId: order.id || order.number || order.order_number, expireAt: 0 };
  }
  if (/\bDAY-1500\b/.test(skuConcat) || /(無制限|1日|UNLIMITED)/.test(skuConcat)) {
    return { type: PLAN.UNLIMITED, orderId: order.id || order.number || order.order_number, expireAt: endOfTodayTs() };
  }
  if (/\bSUB-3000\b/.test(skuConcat) || /(定期|月額|SUBSCRIPTION)/.test(skuConcat)) {
    return { type: PLAN.MONTHLY, orderId: order.id || order.number || order.order_number, expireAt: 0 };
  }

  // 3) 金額フォールバック（税込み金額や payment_amount を参照）
  const amounts = [];
  const mayPush = v => { if (typeof v === "number" && isFinite(v)) amounts.push(v); };
  mayPush(order?.payment_amount);
  mayPush(order?.total_amount);
  mayPush(order?.amount);
  // items配下に単価がある場合の合計
  for (const arr of arrays) {
    let sum = 0, ok = false;
    for (const it of arr) {
      const qty = Number(it?.quantity ?? it?.qty ?? 1) || 1;
      const price = Number(it?.price ?? it?.amount ?? it?.total) || 0;
      if (price > 0) { sum += price * qty; ok = true; }
    }
    if (ok) amounts.push(sum);
  }
  const maxAmt = amounts.length ? Math.max(...amounts) : 0;
  console.log("💰 金額候補:", amounts);

  // だいたいの税込み帯で判定（必要なら調整）
  if (maxAmt >= 400 && maxAmt <= 700) {
    return { type: PLAN.TRIAL, orderId: order.id || order.number || order.order_number, expireAt: 0 };
  }
  if (maxAmt >= 1200 && maxAmt <= 2000) {
    return { type: PLAN.UNLIMITED, orderId: order.id || order.number || order.order_number, expireAt: endOfTodayTs() };
  }
  if (maxAmt >= 2500 && maxAmt <= 4000) {
    return { type: PLAN.MONTHLY, orderId: order.id || order.number || order.order_number, expireAt: 0 };
  }

  console.log("⚠️ プラン不明: マッチなし");
  return null;
}


// ========= LLM =========
async function safeName(userId){
  try{ const p = await client.getProfile(userId); return p.displayName || "あなた"; }
  catch{ return "あなた"; }
}
function buildPrompt(name, history){
  const recent = history.slice(-6).map(m => `${m.role==="user"?"ユーザー":"占い師"}：${m.content}`).join("\n");
  return `あなたは日本語で鑑定する温かいプロ占い師『りゅうせい』。
結論→理由→アクション→注意点→ひとこと励まし の順で300〜500字。
断定しすぎず、実行可能な提案を必ず入れる。恐怖を煽らない。
医療/法律/投資の確約は禁止。

【直近会話要約】
${recent || "（初回）"}

相談者: ${name}
【鑑定】`;
}
async function generateWithOpenAI(prompt, history){
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const messages = [
    { role:"system", content:"あなたは誠実で具体的な助言を行う占い師『りゅうせい』。" },
    ...history.slice(-6).map(m=>({role:m.role, content:m.content})),
    { role:"user", content: prompt },
  ];
  const body = { model: MODEL, messages, temperature: 0.8, top_p: 0.9, max_tokens: 500 };

  for (let i=0;i<2;i++){
    try{
      const r = await fetch("https://api.openai.com/v1/chat/completions",{
        method:"POST",
        headers:{ "Content-Type":"application/json", Authorization:`Bearer ${apiKey}` },
        body: JSON.stringify(body)
      });
      if (r.status===429){
        const t = await r.text();
        if (t.includes("insufficient_quota")) return "【お知らせ】鑑定枠が上限に達しています。時間を置いてお試しください。";
        await new Promise(res=>setTimeout(res, 1200)); continue;
      }
      if (!r.ok) throw new Error(`OpenAI ${r.status} ${await r.text()}`);
      const data = await r.json();
      return data.choices?.[0]?.message?.content?.trim() || null;
    }catch(e){ console.error("LLM error:", e.message||e); await new Promise(res=>setTimeout(res, 800)); }
  }
  return null;
}
function fallbackReply(){
  return `【結論】流れは落ち着いて上向き。焦らず整えるほど成果に結びつきます。
【理由】足元を固めるほど選択の質が上がる運気。
【アクション】今日ひとつだけ「連絡／整理／メモ化」を完了。
【注意点】夜の衝動決断は回避。判断は翌朝に。
【ひとこと励まし】丁寧な一歩が未来の近道です。`;
}
function reply(event, text){ return client.replyMessage(event.replyToken, { type:"text", text }); }

// ===== 起動 =====
const port = process.env.PORT || 10000;
app.listen(port, ()=>console.log(`Server running on ${port}`));






