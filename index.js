import express from "express";
import { Client, middleware } from "@line/bot-sdk";

const app = express();

const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new Client(config);

app.post("/webhook", middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    console.log("Received events:", events);

    // 各イベントに対応
    for (const event of events) {
      if (event.type === "message" && event.message.type === "text") {
        const userMessage = event.message.text;
        const replyText = `🔮占いBOTより\nあなたのメッセージ：「${userMessage}」を受け取りました✨`;

        await client.replyMessage(event.replyToken, {
          type: "text",
          text: replyText,
        });
      }
    }

    res.status(200).end();
  } catch (error) {
    console.error("Error:", error);
    res.status(500).end();
  }
});

// Renderがポートを自動で割り当てる
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
