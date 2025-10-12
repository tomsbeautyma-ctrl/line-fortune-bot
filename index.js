// index.js — 購入者限定 / STORES注文認証 / Redis永続 / 3プラン対応（完全版）

import express from "express";
import fetch from "node-fetch";
import dayjs from "dayjs";
import { Client, middleware } from "@line/bot-sdk";

/* ========= 環境変数 =========
LINE_ACCESS_TOKEN, LINE_CHANNEL_SECRET
OPENAI_API_KEY, MODEL

STORES_API_BASE  (例: https://api.stores.jp)
STORES_API_KEY   (読み取り用APIキー)  ※Bearer or X-API-KEY どちらでも

REDIS_URL, REDIS_TOKEN  (Upstash REST)
STORE_URL
PORT (Render推奨: 10000)
============================ */

const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const MODEL = process.env.MODEL || "gpt-4o-mini";
const STORE_URL = process.env.STORE_URL || "https://beauty-one.stores.jp";

const STORES_API_BASE = (process.env.STORES_API_BASE || "https://api.stores.jp").replace(/\/$/, "");
const STORES_API_KEY  = process.env.STORES_API_KEY || "";

const REDIS_URL   = process.env.REDIS_URL || "";
const REDIS_TOKEN = process.env.REDIS_TOKEN || "";

const APP_REV = "rev-2025-10-12-2215";
console.log("[BOOT]", APP_REV);

const app = express();
const client = new Client(config);

// ========= Redisラッパ =========
async function kvGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  if (!r.ok) return null;
  const j = await r.json(); return j?.result ?? null;
}
async function kvSet(key, val) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(val)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
}
async function kvDel(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  await fetch(`${REDIS_URL}/del/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
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
"お試し鑑定は 1購入につき1質問です。再度ご利用の際はご購入後、表示される【注文番号】を「認証 注文番号」で送ってください。";

const HELP_MSG =
`使い方：
1) ストアで購入 → 注文番号を取得
2) LINEで「認証 1234ABCD」と送信
3) 有効化後にご相談内容を送信

🔗 購入：${STORE_URL}`;

// ========= プラン =========
const PLAN = { NONE:"none", TRIAL:"trial", UNLIMITED:"unlimited", MONTHLY:"monthly" };
function endOfTodayTs(){ return dayjs().endOf("day").valueOf(); }

// ========= ヘルス系 =========
app.get("/health", (_,res)=>res.status(200).send("healthy"));
app.get("/",       (_,res)=>res.status(200).send("OK"));
app.get("/env",    (req,res)=>{
  const OPENAI = !!process.env.OPENAI_API_KEY;
  res.status(200).json({ MODEL, OPENAI, STORE_URL, STORES_API_BASE, REDIS: !!REDIS_URL, APP_REV });
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

  // メニュー
  if (["メニュー","/menu","menu","help","？","?"].includes(text)) {
    return reply(event, HELP_MSG);
  }
  if (["リセット","/reset","reset"].includes(text)) {
    await kvDel(`sess:${userId}`);
    return reply(event, "会話履歴をリセットしました。ご相談内容をどうぞ。");
  }

  // ========== 認証（注文番号） ==========
  const auth = text.match(/^(?:認証|認識|注文|コード|order)\s+([A-Za-z0-9\-_]{5,})$/i);
  const justOrder = !auth && text.match(/^([A-Za-z0-9\-_]{6,})$/);
  if (justOrder) {
    return reply(event, `ご購入ありがとうございます。\n認証の形式で送ってください：\n例）認証 ${justOrder[1]}`);
  }

  if (auth) {
    const orderNo = auth[1];
    const used = await kvGet(`order:used:${orderNo}`);
    if (used === "1") {
      return reply(event, "この注文番号はすでに使用済みです。ご不明点はサポートまで。");
    }

    const order = await fetchStoresOrder(orderNo); // ← 重要：orderNo を渡す
    if (!order) return reply(event, "購入が確認できませんでした。注文番号をご確認ください。");
    if (!isPaid(order)) return reply(event, "お支払い未確認です。決済完了後に再度お試しください。");

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

  // ========== 鑑定フロー ==========
  const hist = await loadSession(userId);
  hist.push({ role:"user", content:text });
  while (hist.length > 10) hist.shift();

  const name = await safeName(userId);
  const prompt = buildPrompt(name, hist);
  const answer = await generateWithOpenAI(prompt, hist) || fallbackReply();

  hist.push({ role:"assistant", content:answer });
  await saveSession(userId, hist);

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

// ========= STORES API（検索API＋ID直参照 / JSON強制 / 両方式Auth） =========
async function fetchStoresOrder(orderInput) {
  if (!STORES_API_KEY) {
    console.log("❌ STORES_API_KEY 未設定");
    return null;
  }
  const base = STORES_API_BASE;
  const headersList = [
    { Authorization: `Bearer ${STORES_API_KEY}`, Accept: "application/json" },
    { "X-API-KEY": STORES_API_KEY,           Accept: "application/json" },
  ];

  console.log("🟡 [AUTH try] 注文番号:", orderInput, "BASE:", base);

  const tryFetch = async (url) => {
    for (const h of headersList) {
      try {
        console.log("➡️  fetch:", url, "headers:", Object.keys(h).join(","));
        const r = await fetch(url, { headers: h });
        const text = await r.text();
        const ctype = r.headers.get("content-type") || "";
        if (r.ok && ctype.includes("application/json")) {
          const j = JSON.parse(text);
          console.log("✅ STORES応答成功:", url);
          return j;
        } else {
          console.log("⚠️ STORES応答:", r.status, url, "ctype:", ctype, "body:", text.slice(0, 140));
        }
      } catch (e) {
        console.log("❌ STORES fetch err:", url, e.message || e);
      }
    }
    return null;
  };

  // ✅ 注文番号で検索
  const q = encodeURIComponent(orderInput);
  let list = await tryFetch(`${base}/v1/orders/search?query=${q}`);

  if (list?.orders?.length) {
    const hit = list.orders.find(o =>
      [o.number, o.order_number].some(v => String(v) === String(orderInput))
    );
    if (hit) {
      console.log("✅ 注文番号ヒット:", hit.number || hit.order_number);
      return hit;
    }
  }

  // ✅ 内部ID直指定のフォールバック
  const one = await tryFetch(`${base}/v1/orders/${q}`);
  if (one && (one.id || one.number || one.order_number)) {
    console.log("✅ IDヒット:", one.id);
    return one;
  }

  console.log("❌ 注文が見つかりません:", orderInput);
  return null;
}

function isPaid(order){
  const s = String(order?.status || "").toLowerCase();
  const ok = ["paid","authorized","captured","settled","paid_and_shipped"].some(x => s.includes(x));
  console.log("🔎 支払い状態:", s, "→", ok ? "有効" : "未決済");
  return ok;
}

function inferPlan(order){
  const items = order?.items || order?.line_items || [];
  const skuConcat = items.map(it => `${it.sku || ""}:${it.title || it.name || ""}`).join(" ").toUpperCase();

  console.log("🧾 購入商品:", skuConcat);

  if (/\bTRIAL-500\b/.test(skuConcat) || /お試し/.test(skuConcat)) {
    console.log("🎯 お試しプラン検出");
    return { type: PLAN.TRIAL, orderId: order.id || order.number || order.order_number, expireAt: 0 };
  }
  if (/\bDAY-1500\b/.test(skuConcat) || /(無制限|1日)/.test(skuConcat)) {
    console.log("🎯 1日プラン検出");
    return { type: PLAN.UNLIMITED, orderId: order.id || order.number || order.order_number, expireAt: endOfTodayTs() };
  }
  if (/\bSUB-3000\b/.test(skuConcat) || /(定期|月額)/.test(skuConcat)) {
    console.log("🎯 月額プラン検出");
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
        await new Promise(res=>setTimeout(res, 1200));
        continue;
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
