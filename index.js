import 'dotenv/config';
import express from 'express';
import { middleware, Client } from '@line/bot-sdk';
import fetch from 'node-fetch';

// ===== 設定 =====
const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
};
const app = express();
app.use(middleware(config));
app.use(express.json());

// ===== ストレージ層（Redis or メモリ）=====
const useRedis = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

// メモリfallback（開発用）
const memory = {
  codes: new Map(),     // code -> { used: boolean, userId: string|null, createdAt:number }
  verified: new Set()   // userId set
};

// Upstashヘルパ
async function redisFetch(path, body) {
  const res = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
    body: JSON.stringify(body)
  });
  return res.json();
}

// コードキー命名
const keyCode = (code) => `code:${code}`;
const keyUserVerified = (uid) => `user:${uid}:verified`;

// コード登録（複数）
async function storeCodes(codes) {
  if (!useRedis) {
    for (const c of codes) memory.codes.set(c, { used: false, userId: null, createdAt: Date.now() });
    return;
  }
  for (const c of codes) {
    await redisFetch('set', { key: keyCode(c), value: JSON.stringify({ used: false, userId: null, createdAt: Date.now() }) });
  }
}

// コード検証＆消費
async function consumeCodeForUser(code, userId) {
  if (!/^\d{9}$/.test(code)) return { ok: false, reason: 'format' };
  if (!useRedis) {
    const rec = memory.codes.get(code);
    if (!rec) return { ok: false, reason: 'notfound' };
    if (rec.used) return { ok: false, reason: 'used' };
    rec.used = true; rec.userId = userId;
    memory.verified.add(userId);
    return { ok: true };
  }
  // Redis版
  const getRes = await redisFetch('get', { key: keyCode(code) });
  if (!getRes || !getRes.result) return { ok: false, reason: 'notfound' };
  const rec = JSON.parse(getRes.result);
  if (rec.used) return { ok: false, reason: 'used' };
  rec.used = true; rec.userId = userId;
  await redisFetch('set', { key: keyCode(code), value: JSON.stringify(rec) });
  await redisFetch('set', { key: keyUserVerified(userId), value: '1' });
  return { ok: true };
}

// 認証確認
async function isVerified(userId) {
  if (!useRedis) return memory.verified.has(userId);
  const r = await redisFetch('get', { key: keyUserVerified(userId) });
  return !!(r && r.result === '1');
}

// ===== 9桁コード生成（管理者用エンドポイント）=====
function generateCodes(n) {
  const out = new Set();
  while (out.size < n) {
    const code = Math.floor(100000000 + Math.random() * 900000000).toString();
    out.add(code);
  }
  return [...out];
}

// 管理者：コードを発行して保存（簡易版）
// ※本番はBasic認証や固定トークンで保護してください
app.post('/admin/codes/create', async (req, res) => {
  const n = Number(req.query.n || 10);
  const codes = generateCodes(n);
  await storeCodes(codes);
  res.json({ ok: true, codes });
});

// ===== OpenAI互換APIで占い =====
async function runFortuneAI(userQuery, style = '恋愛') {
  const base = process.env.OPENAI_BASE_URL;
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  const sys = `あなたは一流の占い師です。結果は必ず「占い結果」として提示し、結論を先に、ポジティブな提案と具体的行動を添え、日本語で300字前後、句読点は控えめ、段落改行あり、敬語で。フィクションとして提供してください。テーマ:${style}`;
  const user = userQuery;

  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user }
      ],
      temperature: 0.7
    })
  });
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content?.trim() || '占い結果の生成に失敗しました。時間を置いてお試しください。';
  return text;
}

// ===== LINE Webhook =====
const client = new Client(config);

app.post('/webhook', async (req, res) => {
  const events = req.body.events;
  await Promise.all(events.map(handleEvent));
  res.status(200).end();
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const userId = event.source.userId;
  const text = (event.message.text || '').trim();

  // 1) 認証コード試行
  if (/^\d{9}$/.test(text)) {
    const result = await consumeCodeForUser(text, userId);
    if (result.ok) {
      return reply(event, [
        '認証が完了しました。ありがとうございます。',
        'これ以降は「占って」「恋愛占い」「仕事運」などお好きに話しかけてください。'
      ].join('\n'));
    } else {
      const reasonMap = {
        format: '9桁の数字のみを送ってください。',
        notfound: 'このコードは登録がありません。入力ミスがないかご確認ください。',
        used: 'このコードはすでに使用済みです。別のコードをご利用ください。'
      };
      return reply(event, reasonMap[result.reason] || 'コード認証に失敗しました。');
    }
  }

  // 2) 認証ユーザーか確認
  const verified = await isVerified(userId);

  // 2-A) 未認証なら案内
  if (!verified) {
    return reply(event,
      [
        'AI占いのご利用には認証が必要です。',
        '9桁の認証コードをこのトークに送信してください。',
        '（例）482913657'
      ].join('\n')
    );
  }

  // 2-B) 認証済み → 占い稼働
  // 簡易ルーティング
  let theme = '総合';
  if (/(恋|愛|彼|彼女|復縁|相性)/.test(text)) theme = '恋愛';
  else if (/(仕|転職|仕事|上司|同僚|昇進)/.test(text)) theme = '仕事';
  else if (/(金|財|収入|お金|投資)/.test(text)) theme = '金運';
  else if (/(健|体|メンタル|疲れ)/.test(text)) theme = '健康';

  const prompt = `質問者の相談: ${text}\n必要なら時期や相性、注意点も含めてください。最後に今日からできる一歩を入れてください。`;
  const ai = await runFortuneAI(prompt, theme);
  return reply(event, ai);
}

function reply(event, text) {
  return client.replyMessage(event.replyToken, { type: 'text', text });
}

// ===== 健康チェック =====
app.get('/', (_, res) => res.send('ok'));

// ===== 起動 =====
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on :${port}`));
