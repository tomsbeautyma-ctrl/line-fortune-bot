import 'dotenv/config';
import express from 'express';
import { middleware, Client } from '@line/bot-sdk';

// ========== 必須環境変数チェック ==========
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ENV: ${name}`);
  return v;
}

const LINE_CHANNEL_SECRET = requireEnv('LINE_CHANNEL_SECRET');
const LINE_CHANNEL_ACCESS_TOKEN = requireEnv('LINE_CHANNEL_ACCESS_TOKEN');
const OPENAI_BASE_URL = requireEnv('OPENAI_BASE_URL');
const OPENAI_API_KEY = requireEnv('OPENAI_API_KEY');
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ========== LINE設定 ==========
const config = {
  channelSecret: LINE_CHANNEL_SECRET,
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN
};
const client = new Client(config);
const app = express();
app.use(middleware(config));
app.use(express.json());

// ========== 簡易メモリDB ==========
const memory = {
  codes: new Map(), // code → { used, userId }
  verified: new Set()
};

// 9桁コード生成
function generateCodes(n = 5) {
  const out = [];
  while (out.length < n) {
    const code = Math.floor(100000000 + Math.random() * 900000000).toString();
    out.push(code);
    memory.codes.set(code, { used: false, userId: null });
  }
  return out;
}

// 管理用（Renderコンソールで叩ける）
app.get('/admin/create', (req, res) => {
  const n = Number(req.query.n || 5);
  const codes = generateCodes(n);
  res.json({ ok: true, codes });
});

// ========== 認証関連 ==========
async function consumeCodeForUser(code, userId) {
  if (!/^\d{9}$/.test(code)) return { ok: false, reason: 'format' };
  const rec = memory.codes.get(code);
  if (!rec) return { ok: false, reason: 'notfound' };
  if (rec.used) return { ok: false, reason: 'used' };
  rec.used = true;
  rec.userId = userId;
  memory.verified.add(userId);
  return { ok: true };
}
function isVerified(userId) {
  return memory.verified.has(userId);
}

// ========== OpenAI互換API ==========
async function runFortuneAI(userQuery, style = '総合') {
  const sys = `あなたは一流の占い師です。必ず「占い結果」として提示し、結論を先に書き、ポジティブな提案と行動アドバイスを入れてください。句読点少なめ、敬語で段落を分けて300字前後。テーマ:${style}`;
  const body = {
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: userQuery }
    ],
    temperature: 0.7
  };

  const r = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const j = await r.json();
  return j.choices?.[0]?.message?.content?.trim() || '占い結果の生成に失敗しました。';
}

// ========== LINE webhook ==========
app.post('/webhook', async (req, res) => {
  const events = req.body.events;
  await Promise.all(events.map(handleEvent));
  res.status(200).end();
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const text = event.message.text.trim();
  const userId = event.source.userId;

  // 認証コード判定
  if (/^\d{9}$/.test(text)) {
    const result = await consumeCodeForUser(text, userId);
    if (result.ok) {
      return reply(event, '認証が完了しました。\nこれ以降は「占って」「恋愛占い」など自由に話しかけてください✨');
    }
    const msg = {
      format: '9桁の数字のみを送ってください。',
      notfound: 'このコードは存在しません。',
      used: 'このコードはすでに使用されています。'
    };
    return reply(event, msg[result.reason] || '認証エラーが発生しました。');
  }

  // 認証チェック
  if (!isVerified(userId)) {
    return reply(event, 'AI占いを利用するには9桁の認証コードを送信してください。\n（例）482913657');
  }

  // 占い
  let theme = '総合';
  if (/(恋|愛|彼|彼女|復縁)/.test(text)) theme = '恋愛';
  else if (/(仕|転職|上司|同僚)/.test(text)) theme = '仕事';
  else if (/(金|財|収入)/.test(text)) theme = '金運';
  else if (/(健|体|メンタル)/.test(text)) theme = '健康';

  const ai = await runFortuneAI(text, theme);
  return reply(event, ai);
}

function reply(event, text) {
  return client.replyMessage(event.replyToken, { type: 'text', text });
}

// ========== テスト用 ==========
app.get('/', (req, res) => res.send('ok'));
app.get('/_diag/env', (req, res) => {
  const keys = ['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'];
  const result = Object.fromEntries(keys.map(k => [k, !!process.env[k]]));
  res.json(result);
});

// ========== 起動 ==========
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on port ${port}`));
