// index.js — 会話できる占いLINE Bot（履歴メモリ + GPT）

import express from "express";
import fetch from "node-fetch";
import { Client, middleware } from "@line/bot-sdk";

const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.error("LINE環境変数が不足しています。");
}

const app = express();
const client = new Client(config);

// ---- 会話メモリ（簡易/プロセス内） ----
const sessions = new Map(); // userId -> [{role, content}]
const MAX_TURNS = 12;

// ヘルスチェック
app.get("/health", (_, res) => res.status(200).send("healthy"));
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/env", (_, res) => {
  res.json({
    MODEL: process.env.MODEL || "gpt-4o-mini",
    OPENAI: !!process.env.OPENAI_API_KEY,
  });
});
// --- STORES注文確認関数 ---
async function verifySubscription(email) {
  try {
    const res = await fetch("https://api.stores.jp/v1/orders", {
      headers: { Authorization: `Bearer ${process.env.STORES_API_KEY}` }
    });
    const data = await res.json();
    return data.orders?.some(order =>
      order.email === email &&
      order.status === "paid" &&
      order.title.includes("定期鑑定")
    );
  } catch (e) {
    console.error("STORES verify error:", e);
    return false;
    // --- 定期プランチェック機能 ---
async function checkPlanAndReply(event, userId, text) {
  if (text.includes("定期プラン開始")) {
    try {
      const profile = await client.getProfile(userId);
      const email = profile?.email || ""; // STORES購入時のメール想定
      const valid = await verifySubscription(email);

      if (!valid) {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text:
            "⚠️ この機能は定期鑑定プラン（月額3,000円）ご契約者限定です🌙\n" +
            "ご購入はこちらから💫\n" +
            "👉 https://yourshop.stores.jp"
        });
        return false; // 鑑定を実行しない
      }

      await client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "🌕ご契約が確認できました！\n" +
          "本日もあなたの運気を鑑定いたします🔮✨"
      });
      return true; // OK
    } catch (e) {
      console.error("checkPlanAndReply error:", e);
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "システムエラーが発生しました。少し時間をおいて再試行してください。"
      });
      return false;
    }
  }
  return null; // 「定期プラン開始」以外のメッセージならスルー
}

  }
}

// Webhook 受信
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
const planCheck = await checkPlanAndReply(event, userId, text);
if (planCheck !== null) return; // 定期プランメッセージならここで終了

  const userId = event.source.userId;
  const text = (event.message.text || "").trim();
  console.log("LINE msg:", userId, text);

  // ---- コマンド ----
  if (["/reset","リセット","reset"].includes(text)) {
    sessions.delete(userId);
    return client.replyMessage(event.replyToken, { type: "text", text: "履歴をリセットしました。何を占いますか？" });
  }
  if (["/menu","メニュー","help","？","?"].includes(text)) {
    return client.replyMessage(event.replyToken, { type: "text", text:
      "🔮 占いメニュー\n・総合鑑定\n・恋愛/復縁/片想い\n・仕事/転職\n・金運\n・健康/生活リズム\n\n※「リセット」で履歴消去" });
  }

  // ---- 履歴更新 ----
  const hist = sessions.get(userId) || [];
  hist.push({ role: "user", content: text });
  while (hist.length > MAX_TURNS) hist.shift();

  // ---- プロンプト生成 ----
  const prompt = buildPrompt(hist);

  // ---- 生成（OpenAI） ----
  const reply = await generateWithOpenAI(prompt, hist) || fallbackReply();

  // 履歴へ追加
  hist.push({ role: "assistant", content: reply });
  sessions.set(userId, hist);

  // 返信
  return client.replyMessage(event.replyToken, { type: "text", text: reply.slice(0, 4900) });
}

function buildPrompt(history) {
  const recent = history.slice(-6)
    .map(m => `${m.role === "user" ? "ユーザー" : "占い師"}：${m.content}`)
    .join("\n");

  return `あなたは日本語で鑑定するプロ占い師『りゅうせい』。
結論→理由→アクション→注意点→ひとこと励まし の順で300〜500字。
断定しすぎずやさしい敬語で、実行可能な提案を必ず入れる。
医療・法律・投資の確約は禁止。相手を不安にさせる表現は避ける。

【直近会話要約】
${recent || "（初回）"}

【鑑定】`;
}

async function generateWithOpenAI(prompt, history) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.MODEL || "gpt-4o-mini";
  if (!apiKey) {
    console.warn("OPENAI_API_KEY が未設定");
    return null;
  }
  try {
    const messages = [
      { role: "system", content:
        "あなたは温かく誠実な占い師『りゅうせい』。相談者の不安を和らげ、具体的行動を提示する。" },
      ...history.slice(-6).map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: prompt },
    ];
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature: 0.8, top_p: 0.9, max_tokens: 700 })
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`OpenAI ${res.status} ${t}`);
    }
    const data = await res.json();
    const out = data.choices?.[0]?.message?.content?.trim();
    console.log("LLM ok");
    return out || null;
  } catch (e) {
    console.error("LLM error:", e.message);
    return null;
  }
}

function fallbackReply() {
  return `【結論】流れは落ち着いて上向き。焦らず整えるほど成果に結びつきます。
【理由】足元を固めるほど選択の質が上がる運気。
【アクション】今日ひとつだけ「連絡／整理／メモ化」を完了。
【注意点】夜の衝動決断は回避。判断は翌朝に。
【ひとこと励まし】丁寧な一歩が未来の近道です。`;
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));

// 追加：LLMヘルスチェック（テスト後に消してOK）
app.get("/ping-llm", async (_, res) => {
  try {
    const msg = await generateWithOpenAI("テスト鑑定を1文で。", []);
    if (msg) return res.status(200).send("LLM ok: " + msg.slice(0, 60));
    return res.status(500).send("LLM ng (fallback)");
  } catch (e) {
    return res.status(500).send("LLM error: " + (e.message || e));
  }
});




