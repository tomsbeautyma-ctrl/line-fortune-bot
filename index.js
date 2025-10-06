// index.js — LINE + GPT-5 占いBot（ESM）

import express from "express";
import { Client, middleware } from "@line/bot-sdk";

// ====== LINE設定 ======
const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();
const client = new Client(config);

// ヘルスチェック
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/health", (_, res) => res.status(200).send("healthy"));

// ====== Webhook ======
app.post("/webhook", middleware(config), async (req, res) => {
  try {
    const events = req.body?.events ?? [];
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userText = (event.message.text || "").trim();

  // プロフィール名（任意）
  let name = "あなた";
  try {
    const p = await client.getProfile(event.source.userId);
    name = p.displayName || name;
  } catch {}

  // テーマ分類
  const { topic, detail } = classifyTopic(userText);

  // プロンプト組み立て
  const prompt = buildPrompt({ name, topic, detail });

  // GPT-5 or フォールバックで生成
  const fortune = await generateFortuneWithOpenAI(prompt);

  // 返信
  await client.replyMessage(event.replyToken, {
    type: "text",
    text: fortune.slice(0, 4900), // LINEの上限対策
  });
}

// ====== テーマ判定 ======
function classifyTopic(t) {
  const s = (t || "").replace(/\s+/g, " ").trim();
  if (!s) return { topic: "総合", detail: "" };

  const pair = s.match(/^(相性)\s+(.+?)\s+(.+)$/);
  if (pair) return { topic: "相性", detail: `${pair[2]} と ${pair[3]} の相性` };

  if (/恋|愛|出会い|結婚|復縁/.test(s)) return { topic: "恋愛", detail: s };
  if (/仕事|転職|職場|昇進|独立|キャリア/.test(s)) return { topic: "仕事", detail: s };
  if (/金運|お金|収入|貯金|投資/.test(s)) return { topic: "金運", detail: s };
  if (/健康|体調|疲れ|睡眠/.test(s)) return { topic: "健康", detail: s };
  if (/総合|全体|運勢|運気/.test(s)) return { topic: "総合", detail: s };
  return { topic: "総合", detail: s };
}

// ====== プロンプト ======
function buildPrompt({ name, topic, detail }) {
  const goalMap = {
    総合: "全体運・課題・今週の追い風",
    恋愛: "出会い/進展/関係修復の可能性",
    仕事: "キャリア方針・転機・準備すべき行動",
    金運: "収支改善・チャンス領域・注意点",
    健康: "生活の整え方・疲労回復・無理の線引き",
    相性: "二人の相性・関係の活かし方",
  };
  const goal = goalMap[topic] || "相談の核心";

  return `あなたは優しく誠実なプロ占い師。相談者の不安を和らげ、結論を先に、根拠と具体アクションを簡潔に返す。
出力ルール:
- 見出し: 「結論」「理由」「7日以内の開運アクション」「注意点」「ラッキー情報」
- 文字数: 320〜520字。敬体。断定しすぎず、曖昧すぎない。
- テーマ: ${topic}（目的: ${goal}）
- NG: 医療/法律/投資の確約、恐怖を煽る表現、個人攻撃、公序良俗に反する助言
- 最後に一言、背中を押す励まし。

相談者: ${name}
相談内容: ${detail || topic}

【鑑定開始】`;
}

// ====== GPT-5 呼び出し（OpenAI Chat Completions 使用） ======
async function generateFortuneWithOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.MODEL || "gpt-5"; // gpt-5 / gpt-5-mini など

  if (!apiKey) {
    console.warn("OPENAI_API_KEY 未設定。フォールバックを返します。");
    return fallbackFortune();
  }

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "あなたは優しく的確な占い師です。倫理ガイドラインに従い、実務的な助言を添えて返答します。",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.9, // 多様性
        max_tokens: 700,
      }),
    });

    if (!res.ok) throw new Error(`OpenAI API ${res.status}`);
    const data = await res.json();
    const text =
      data.choices?.[0]?.message?.content?.trim() || fallbackFortune();
    return text;
  } catch (e) {
    console.error("LLM error:", e);
    return fallbackFortune();
  }
}

// ====== フォールバック（API未設定・障害時用） ======
function fallbackFortune() {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const colors = ["深い青", "ラベンダー", "エメラルド", "サンセットオレンジ", "ミント", "琥珀"];
  const acts = [
    "朝3分の深呼吸とストレッチ",
    "今日の優先3タスクを書き出す",
    "机上を5分だけ片付ける",
    "連絡1件を丁寧に返す",
    "温かい飲み物でひと息つく",
  ];
  return `【結論】
流れは静かに上向き。焦らず整えるほど成果がまとまります。

【理由】
過去の積み重ねが評価されやすい運気。新規より「磨く」が吉。

【7日以内の開運アクション】
・${pick(acts)}
・情報は取り込み過ぎず、夕方に要点整理
・小さな約束を必ず守る

【注意点】
夜更かしと衝動的な決断。判断は翌朝に回すと冴えます。

【ラッキー情報】
ラッキーカラー：${pick(colors)}
ラッキーアクション：姿勢を正して歩く

力は十分。一歩ずつ整えるほど、チャンスは自然と近づきます。`;
}

// ====== 起動 ======
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));
