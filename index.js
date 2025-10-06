import express from "express";
import { Client, middleware } from "@line/bot-sdk";

// ===== 基本設定 =====
const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();
const client = new Client(config);

// ヘルスチェック（Renderの監視用）
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/health", (_, res) => res.status(200).send("healthy"));

// ===== Webhook本体 =====
app.post("/webhook", middleware(config), async (req, res) => {
  try {
    const events = req.body.events ?? [];
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  // テキストだけ対応（他イベントは無視）
  if (event.type !== "message" || event.message.type !== "text") return;

  const userId = event.source.userId;
  let profileName = "あなた";
  try {
    const profile = await client.getProfile(userId);
    profileName = profile.displayName || profileName;
  } catch (_) {}

  const userText = event.message.text?.trim() || "";

  // コマンド風の簡易メニュー
  if (["メニュー", "menu", "はじめる"].includes(userText)) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "🔮 占いメニュー\n" +
        "・「総合鑑定」→ いまの全体運/課題/開運アクション\n" +
        "・「恋愛」,「仕事」,「金運」などテーマ指定もOK\n" +
        "・例）『恋愛　出会いのタイミング』",
    });
  }

  // ===== ここで占い文を生成 =====
  const prompt = buildPrompt({ name: profileName, question: userText });
  const fortune = await generateFortune(prompt);

  // 返信
  await client.replyMessage(event.replyToken, [
    { type: "text", text: fortune.slice(0, 4900) }, // LINEは1メッセ約5000字上限
  ]);
}

// ===== プロンプト設計 =====
function buildPrompt({ name, question }) {
  return `あなたは優しく誠実なプロ占い師。相談者の不安を和らげ、結論を先に、根拠と具体アドバイスを簡潔に返す。
出力ルール:
- 見出し: 「結論」「理由」「7日以内の開運アクション」「注意点」「ラッキー情報」
- 文字数: 300〜500字。敬体。断定しすぎないが、曖昧すぎない。
- NG: 医療/法律/投資の確約。個人攻撃。恐怖を煽る表現。
- 最後に軽い励ましを1文。

相談者: ${name}
相談内容: ${question || "総合鑑定（運勢全般）"}

【鑑定開始】`;
}

// ===== GPT-OSS 連携（環境変数がなければテンプレで代替） =====
async function generateFortune(prompt) {
  const apiUrl = process.env.FORTUNE_API_URL;   // 例）https://your-oss-endpoint/v1/generate
  const apiKey = process.env.FORTUNE_API_KEY || "";

  // 環境変数が未設定ならテンプレ回答（まずは動かすための保険）
  if (!apiUrl) {
    return fallbackFortune(prompt);
  }

  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        prompt,
        max_new_tokens: 650,
        temperature: 0.7,
      }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}`);
    const data = await res.json();

    // エンドポイントの仕様に合わせて出力キーを調整してください
    // 例：{ output: "..." } / { text: "..." } / { choices:[{text:"..."}] }
    return (
      data.output ||
      data.text ||
      (data.choices && data.choices[0] && (data.choices[0].text || data.choices[0].message?.content)) ||
      fallbackFortune(prompt)
    );
  } catch (e) {
    console.error("LLM error:", e);
    return fallbackFortune(prompt);
  }
}

// ===== 代替の簡易占い（API未設定や障害時の保険） =====
function fallbackFortune() {
  const luckyColors = ["深い青", "ラベンダー", "エメラルド", "サンセットオレンジ", "ミント"];
  const color = luckyColors[Math.floor(Math.random() * luckyColors.length)];
  return `【結論】
流れは静かに上向き。焦らず足場を整えるほど好転が加速します。

【理由】
過去の積み重ねが評価されやすい時期。新規よりも「今あるものの磨き込み」が吉。

【7日以内の開運アクション】
・朝に5分だけ散歩し、今日やることを3つだけ書き出す
・身近な人へ一言感謝を伝える
・紙に現在の不安を書き出し、対策を1行で添える

【注意点】
夜更かしと情報の取り込み過ぎ。判断は翌朝に回すと冴えます。

【ラッキー情報】
ラッキーカラー：${color}
ラッキーアクション：机の上の小さな片付け

力は十分。少しずつ整えるほどチャンスは手の届くところに集まります。無理なくいきましょう。`;
}

// ===== サーバ起動 =====
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));

