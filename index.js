// index.js — LINE占いBot（会話メモリ/GPT対応）

import express from "express";
import { Client, middleware } from "@line/bot-sdk";

const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();
const client = new Client(config);

// ---- 会話メモリ（簡易：プロセス内） ----
const sessions = new Map(); // userId -> [{role, content}]
const MAX_TURNS = 8;

// ヘルスチェック
app.get("/health", (_, res) => res.status(200).send("healthy"));
app.get("/", (_, res) => res.status(200).send("OK"));

// Webhook
app.post("/webhook", middleware(config), async (req, res) => {
  try {
    const events = req.body?.events ?? [];
    await Promise.all(events.map(handleEvent));
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userId = event.source.userId;
  const text = (event.message.text || "").trim();

  // コマンド
  if (["リセット","reset","/reset"].includes(text)) {
    sessions.delete(userId);
    return client.replyMessage(event.replyToken, { type: "text", text: "会話履歴をリセットしました。どんなことで占いますか？" });
  }
  if (["メニュー","menu","はじめる","help","？","?"].includes(text)) {
    return client.replyMessage(event.replyToken, { type: "text", text:
      "🔮 占いメニュー\n" +
      "・総合鑑定\n・恋愛（例：恋愛 出会い）\n・仕事（例：仕事 転職の流れ）\n" +
      "・金運（例：金運 貯金のコツ）\n・健康（例：健康 生活を整えたい）\n" +
      "・相性 太郎 花子\n\n※「リセット」で履歴消去" });
  }

  const { topic, detail } = classifyTopic(text);
  const name = await safeName(userId);

  // ---- 会話履歴を更新 ----
  const hist = sessions.get(userId) || [];
  hist.push({ role: "user", content: text });
  while (hist.length > MAX_TURNS) hist.shift();
  sessions.set(userId, hist);

  // 短文ならまず確認質問（1往復目でよく効く）
  if (detail.length < 6 && hist.filter(m=>m.role==="user").length <= 1) {
    const q = askFollowUp(topic);
    hist.push({ role: "assistant", content: q });
    return client.replyMessage(event.replyToken, { type: "text", text: q });
  }

  // 鑑定プロンプト
  const prompt = buildPrompt({ name, topic, detail, history: hist });

  // 生成（OpenAIが無ければ会話風フォールバック）
  const reply = await generateWithOpenAI(prompt, hist) || convoFallback(topic, detail, hist);

  // 履歴にassistant追加
  hist.push({ role: "assistant", content: reply });
  sessions.set(userId, hist);

  return client.replyMessage(event.replyToken, { type: "text", text: reply.slice(0, 4900) });
}

async function safeName(userId) {
  try { const p = await client.getProfile(userId); return p.displayName || "あなた"; }
  catch { return "あなた"; }
}

// ---- テーマ判定 ----
function classifyTopic(t) {
  const s = (t || "").replace(/\s+/g, " ").trim();
  if (!s) return { topic: "総合", detail: "" };
  const pair = s.match(/^(相性)\s+(.+?)\s+(.+)$/);
  if (pair) return { topic: "相性", detail: `${pair[2]} と ${pair[3]} の相性` };
  if (/恋|愛|出会い|結婚|復縁|片想い/.test(s)) return { topic: "恋愛", detail: s };
  if (/仕事|転職|職場|昇進|独立|キャリア|人間関係/.test(s)) return { topic: "仕事", detail: s };
  if (/金運|お金|収入|貯金|副業|投資/.test(s)) return { topic: "金運", detail: s };
  if (/健康|体調|睡眠|疲れ|習慣|生活/.test(s)) return { topic: "健康", detail: s };
  if (/総合|全体|運勢|運気/.test(s)) return { topic: "総合", detail: s };
  return { topic: "総合", detail: s };
}

// ---- 追い質問 ----
function askFollowUp(topic) {
  const map = {
    総合: "どの分野を中心にみますか？（恋愛・仕事・金運・健康・人間関係 など）",
    恋愛: "相手の有無や、知りたいポイント（出会い/進展/復縁など）を教えてください。",
    仕事: "今の状況（転職検討/職場の人間関係/昇進など）を一言で教えてください。",
    金運: "収入UP/支出見直し/貯金の増やし方/副業など、気になる方向性はありますか？",
    健康: "睡眠・食事・運動・メンタル・生活リズムのどこを整えたいですか？",
    相性: "お二人の関係性（友人/恋人/家族/同僚など）を教えてください。",
  };
  return "🔎 " + (map[topic] || "もう少し詳しく教えてください。");
}

// ---- プロンプト生成（会話要約を含める） ----
function buildPrompt({ name, topic, detail, history }) {
  const recent = history.slice(-6).map(m => `${m.role === "user" ? "ユーザー" : "占い師"}：${m.content}`).join("\n");
  const flavor = {
    総合: "全体像を俯瞰し、今週の追い風と具体アクションを1〜3個示す。",
    恋愛: "断定しすぎず、行動のきっかけを提案。連絡タイミングや所作まで具体化。",
    仕事: "現実的で実行可能な選択肢を短く比較し、第一歩を明確に。",
    金運: "節制と攻めの両輪。今日できる行動を必ず1つ入れる。",
    健康: "一般的アドバイスに留め、医療指示は行わない。睡眠/食事/運動の視点を一つ。",
    相性: "活かし方・衝突回避・歩み寄りの合図をバランス良く。",
  }[topic];

  return `あなたは優しく誠実なプロ占い師。会話の流れを踏まえ、結論先出し＋根拠＋具体アクションで返答する。
出力ルール:
- 見出し: 「結論」「理由」「アクション」「注意点」「ひとこと励まし」
- 文字数: 300字、敬体。断定しすぎない。
- テーマ: ${topic}。${flavor}
- NG: 医療/法律/投資の確約、恐怖を煽る表現、個人攻撃

【会話の要約（直近）】
${recent || "（初回）"}

相談者: ${name}
相談内容: ${detail || topic}

【鑑定】`;
}

// ---- OpenAI（GPT） ----
async function generateWithOpenAI(prompt, history) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.MODEL || "gpt-5";
  if (!apiKey) return null;

  try {
    const messages = [
     { role: "system", content:
  "あなたは日本語で鑑定するプロ占い師『りゅうせい』。タロット/オーラ/星の比喩を交え、結論→理由→行動→注意→励ましの順で300〜500字で返答。断定しすぎず、優しく、実行可能な提案を必ず入れる。" }
      ...history.slice(-6).map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: prompt },
    ];
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type":"application/json", Authorization:`Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature: 0.9, top_p: 0.9, max_tokens: 700 })
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error("LLM error:", e);
    return null;
  }
}

// ---- 会話風フォールバック ----
function convoFallback(topic, detail, history) {
  const lastQ = history.slice().reverse().find(m => m.role === "assistant" && m.content.startsWith("🔎"));
  if (lastQ && history[history.length - 1]?.role === "user") {
    // 直前が確認質問→ユーザー回答：要約＋次の一歩
    return `ありがとうございます。要点は「${(detail || "詳細") }」ですね。\n\n【結論】焦らず整えるほど運気は素直に伸びます。\n【理由】足元を固めるほど、選択肢の質が上がる流れ。\n【アクション】今日1つだけ、小さな行動（連絡・整理・メモ化）を終わらせましょう。\n【注意点】情報の取り込み過ぎ。判断は翌朝に回すと冴えます。\n【ひとこと励まし】今のペースで十分。丁寧さが未来の近道です。`;
  }
  // 初回などは軽い鑑定テンプレ
  return ``;
}

// 起動
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));

