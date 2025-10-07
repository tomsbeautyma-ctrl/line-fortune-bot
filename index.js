// index.js — LINE占いBot（会話メモリ + GPT）

import express from "express";
import { Client, middleware } from "@line/bot-sdk";

// Node18未満を使っている場合だけ node-fetch を入れてください。
// import fetch from "node-fetch";

const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();
const client = new Client(config);

// ---- 会話メモリ（簡易） ----
const sessions = new Map(); // userId -> [{role, content}]
const MAX_TURNS = 12;

// ヘルス／可視化
app.get("/health", (_, res) => res.status(200).send("healthy"));
app.get("/", (_, res) => res.status(200).send("OK"));
// 確認用（本番では削除してOK）
app.get("/env", (_, res) => {
  res.json({
    MODEL: process.env.MODEL || "gpt-4o-mini (default)",
    OPENAI: !!process.env.OPENAI_API_KEY, // true だけ見れれば十分
  });
});

// Webhook
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

  // コマンド
  if (["リセット","reset","/reset"].includes(text)) {
    sessions.delete(userId);
    return client.replyMessage(event.replyToken, { type: "text", text: "会話履歴をリセットしました。どんなことで占いますか？" });
  }

  // 履歴
  const hist = sessions.get(userId) || [];
  hist.push({ role: "user", content: text });
  while (hist.length > MAX_TURNS) hist.shift();

  const prompt = buildPrompt(hist);

  // 生成
  const reply = await generateWithOpenAI(prompt, hist) || fallbackReply();
  hist.push({ role: "assistant", content: reply });
  sessions.set(userId, hist);

  return client.replyMessage(event.replyToken, { type: "text", text: reply.slice(0, 4900) });
}

function buildPrompt(history) {
  const recent = history.slice(-6).map(m => `${m.role === "user" ? "ユーザー" : "占い師"}：${m.content}`).join("\n");
  return `あなたは日本語で鑑定するプロ占い師『りゅうせい』。
結論→理由→アクション→注意点→ひとこと励まし の順で300〜500字。
断定しすぎず優しい口調で、実行可能な提案を必ず入れる。
医療/法律/投資の確約は禁止。

【直近会話要約】
${recent || "（初回）"}

【鑑定】`;
}

async function generateWithOpenAI(prompt, history) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.MODEL || "gpt-4o-mini";
  if (!apiKey) {
    console.warn("OPENAI_API_KEY missing");
    return null;
  }
  try {
    const messages = [
      { role: "system", content: "あなたは温かく誠実な占い師『りゅうせい』。相談者の不安を和らげ、具体的行動を提示する。" },
      ...history.slice(-6).map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: prompt },
    ];
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type":"application/json", Authorization:`Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature: 0.8, top_p: 0.9, max_tokens: 700 })
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status} ${await res.text()}`);
    const data = await res.json();
    const out = data.choices?.[0]?.message?.content?.trim();
    console.log("LLM ok");
    return out || null;
  } catch (e) {
    console.error("LLM error:", e);
    return null;
  }
}

function fallbackReply() {
  return ``;
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));
