// index.js — LINE占いBot（3プラン対応：お試し/1日無制限/月額定期）

import express from "express";
import fetch from "node-fetch";
import dayjs from "dayjs";
import { Client, middleware } from "@line/bot-sdk";

/* ====== 環境変数 ======
LINE_ACCESS_TOKEN: LINE長期アクセストークン
LINE_CHANNEL_SECRET: LINEチャネルシークレット
OPENAI_API_KEY: OpenAI APIキー
MODEL: gpt-4o-mini（推奨。なければデフォルト使用）
STORE_URL: STORESの商品一覧やLPのURL（未設定でも動作）
===================== */

const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const MODEL = process.env.MODEL || "gpt-4o-mini";
const STORE_URL = process.env.STORE_URL || "https://your-stores.example.com/";

const app = express();
const client = new Client(config);

/* ==========
  簡易DB（プロセス内）
  本番で永続化したい場合は Redis / Firestore などに置換してください。
============= */
const sessions = new Map();   // userId -> [{role, content}]
const users = new Map();      // userId -> { plan, expireAt, trialConsumed }
const MAX_TURNS = 10;

// プラン種別
const PLAN = {
  NONE: "none",
  TRIAL: "trial",        // お試し1回
  UNLIMITED: "unlimited",// 1日無制限
  MONTHLY: "monthly"     // 月額定期
};

// ============ ヘルス系 ===============
app.get("/health", (_, res) => res.status(200).send("healthy"));
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/env", (_, res) => res.json({
  MODEL,
  OPENAI: !!process.env.OPENAI_API_KEY,
  STORE_URL
}));

// LLM疎通テスト（必要なら）
app.get("/ping-llm", async (_, res) => {
  try {
    const msg = await generateWithOpenAI("テスト鑑定を一文で。", []);
    res.status(200).send(msg ? `LLM ok: ${msg.slice(0,60)}` : "LLM fallback");
  } catch (e) {
    res.status(500).send("LLM error: " + (e.message || e));
  }
});

// ============ Webhook ============
app.post("/webhook", middleware(config), async (req, res) => {
  try {
    const events = req.body?.events ?? [];
    await Promise.all(events.map(handleEvent));
    res.sendStatus(200);
  } catch (e) {
    console.error("webhook error:", e);
    res.sendStatus(500);
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userId = event.source.userId;
  const text = (event.message.text || "").trim();
  console.log("LINE msg:", userId, text);

  // --- 初期化 ---
  if (!users.has(userId)) {
    users.set(userId, { plan: PLAN.NONE, expireAt: 0, trialConsumed: false });
  }
  const profileName = await safeName(userId);

  // --- コマンド ---
  // メニュー
  if (["メニュー","menu","/menu","はじめる","help","？","?"].includes(text)) {
    return reply(event, menuText());
  }
  // 状態確認
  if (["/plan","プラン","状態","ステータス"].includes(text)) {
    return reply(event, planStatusText(userId));
  }
  // 履歴リセット
  if (["リセット","/reset","reset"].includes(text)) {
    sessions.delete(userId);
    return reply(event, "会話履歴をリセットしました。占い内容をどうぞ。");
  }

  // --- STORES購入後の合言葉（文言は商品説明に明記） ---
  // 例）「購入完了 お試し」「購入完了 無制限」「購入完了 定期」
  if (/購入完了/.test(text)) {
    const u = users.get(userId);
    if (/お試し|試し|1回/.test(text)) {
      u.plan = PLAN.TRIAL;
      u.expireAt = 0;
      return reply(event, "🪄 お試し1回占い（¥500）を有効化しました。質問を1件どうぞ。");
    }
    if (/無制限|1日|当日/.test(text)) {
      u.plan = PLAN.UNLIMITED;
      u.expireAt = dayjs().endOf("day").valueOf(); // 今日の23:59まで
      return reply(event, "🔮 1日無制限チャット占い（¥1,500）を開始しました。本日中は何件でもOKです。");
    }
    if (/定期|月額|サブスク/.test(text)) {
      u.plan = PLAN.MONTHLY;
      u.expireAt = 0; // 継続。解約はSTORES側で管理
      return reply(event, "💫 月額定期鑑定プラン（¥3,000/月）を有効化しました。いつでもご相談ください。");
    }
    return reply(event, "ご購入ありがとうございます。プラン名を含めて送ってください（例：購入完了 お試し / 購入完了 無制限 / 購入完了 定期）。");
  }

  // --- 利用権チェック ---
  const gate = checkGate(userId);
  if (!gate.ok) {
    return reply(event, gate.msg);
  }

  // === ここから鑑定 ===
  // 履歴
  const hist = sessions.get(userId) || [];
  hist.push({ role: "user", content: text });
  while (hist.length > MAX_TURNS) hist.shift();

  // プロンプト
  const prompt = buildPrompt(profileName, hist);

  // 生成
  const answer = await generateWithOpenAI(prompt, hist) || fallbackReply();

  // 履歴更新
  hist.push({ role: "assistant", content: answer });
  sessions.set(userId, hist);

  // プラン消費処理（お試し1回）
  consumeIfTrial(userId);

  return reply(event, answer.slice(0, 4900));
}

function reply(event, text) {
  return client.replyMessage(event.replyToken, { type: "text", text });
}

async function safeName(userId) {
  try { const p = await client.getProfile(userId); return p.displayName || "あなた"; }
  catch { return "あなた"; }
}

// ============ プラン周り ============
function menuText() {
  return [
    "🌟 Beauty One_Chat — プラン一覧",
    "・お試し1回占い：¥500（キーワード：『購入完了 お試し』）",
    "・無制限チャット占い（1日）：¥1,500（『購入完了 無制限』）",
    "・定期鑑定プラン（月額）：¥3,000（『購入完了 定期』）",
    STORE_URL ? `\nご購入はこちら 👉 ${STORE_URL}` : "",
    "\n※購入後、上記の合言葉をLINEで送って有効化してください。",
    "※/plan で現在のプランを確認できます。"
  ].join("\n");
}

function planStatusText(userId) {
  const u = users.get(userId) || { plan: PLAN.NONE, expireAt: 0, trialConsumed: false };
  const now = Date.now();
  const rest = u.expireAt ? Math.max(0, u.expireAt - now) : 0;
  const human = rest ? dayjs(u.expireAt).format("M/D HH:mm") + " まで" : (u.plan === PLAN.MONTHLY ? "継続中" : "");
  const planName = {
    [PLAN.NONE]: "未購入",
    [PLAN.TRIAL]: `お試し1回（${u.trialConsumed ? "消費済み" : "未消費"}）`,
    [PLAN.UNLIMITED]: "1日無制限",
    [PLAN.MONTHLY]: "月額定期"
  }[u.plan];
  return `現在のプラン：${planName}\n有効期限：${human || "—"}\n${STORE_URL ? `\n購入/更新はこちら 👉 ${STORE_URL}` : ""}`;
}

function checkGate(userId) {
  const u = users.get(userId);
  const now = Date.now();
  // 期限切れ処理
  if (u.plan === PLAN.UNLIMITED && now > u.expireAt) {
    u.plan = PLAN.NONE; u.expireAt = 0;
  }
  // 月額はGateなし
  if (u.plan === PLAN.MONTHLY) return { ok: true };
  // 無制限は期限内OK
  if (u.plan === PLAN.UNLIMITED) return { ok: true };
  // お試しは未消費ならOK
  if (u.plan === PLAN.TRIAL && !u.trialConsumed) return { ok: true };

  // ここまで来たら未購入 or 消費済み
  const msg = [
    "🔔 ご利用にはプランの有効化が必要です。",
    "・お試し1回：¥500 → 『購入完了 お試し』",
    "・1日無制限：¥1,500 → 『購入完了 無制限』",
    "・月額定期：¥3,000 → 『購入完了 定期』",
    STORE_URL ? `\nご購入はこちら 👉 ${STORE_URL}` : ""
  ].join("\n");
  return { ok: false, msg };
}

function consumeIfTrial(userId) {
  const u = users.get(userId);
  if (u.plan === PLAN.TRIAL && !u.trialConsumed) {
    u.trialConsumed = true;
    // 次の発話からGateに引っかかる（追加購入を促す）
  }
}

// ============ 生成系 ============
function buildPrompt(name, history) {
  const recent = history.slice(-6)
    .map(m => `${m.role === "user" ? "ユーザー" : "占い師"}：${m.content}`).join("\n");

  return `あなたは日本語で鑑定する温かいプロ占い師『りゅうせい』。
結論→理由→アクション→注意点→ひとこと励まし の順で300〜500字。
断定しすぎず、実行可能な提案を必ず入れる。恐怖を煽らない。
医療/法律/投資の確約は禁止。

【直近会話要約】
${recent || "（初回）"}

相談者: ${name}
【鑑定】`;
}

async function generateWithOpenAI(prompt, history) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { console.warn("OPENAI_API_KEY missing"); return null; }

  const messages = [
    { role: "system", content: "あなたは誠実で具体的な助言を行う占い師『りゅうせい』。" },
    ...history.slice(-6).map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: prompt },
  ];

  const body = {
    model: MODEL,
    messages,
    temperature: 0.8,
    top_p: 0.9,
    max_tokens: 500
  };

  // 簡易リトライ＋429（残高/レート）ハンドリング
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body)
      });

      if (res.status === 429) {
        const t = await res.text();
        console.error("LLM 429:", t);
        if (t.includes("insufficient_quota")) {
          return "【お知らせ】現在、鑑定枠が上限に達しています。少し時間を置いてお試しください🙏";
        }
        await new Promise(r => setTimeout(r, 1200));
        continue;
      }
      if (!res.ok) throw new Error(`OpenAI ${res.status} ${await res.text()}`);

      const data = await res.json();
      console.log("LLM ok");
      return data.choices?.[0]?.message?.content?.trim() || null;

    } catch (e) {
      console.error("LLM error:", e.message || e);
      await new Promise(r => setTimeout(r, 800));
    }
  }
  return null;
}

function fallbackReply() {
  return `【結論】流れは落ち着いて上向き。焦らず整えるほど成果に結びつきます。
【理由】足元を固めるほど選択の質が上がる運気。
【アクション】今日ひとつだけ「連絡／整理／メモ化」を完了。
【注意点】夜の衝動決断は回避。判断は翌朝に。
【ひとこと励まし】丁寧な一歩が未来の近道です。`;
}

// 起動
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));
