import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { OpenAI } from "openai";

dotenv.config();

const app = express();
const port = Number(process.env.SERVER_PORT || 3001);

app.use(cors());
app.use(express.json());

const ensureClient = () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set.");
  }
  return new OpenAI({ apiKey });
};

app.post("/api/session", async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not set.");
    }

    const model =
      process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";
    const instructions =
      process.env.AGENT_INSTRUCTIONS ||
      "あなたは優しい音声アシスタントです。短く分かりやすく回答してください。";

    const resp = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "realtime=v1",
      },
      body: JSON.stringify({
        model,
        voice: "alloy",
        instructions,
        modalities: ["text", "audio"],
      }),
    });

    const json = await resp.json();

    if (!resp.ok) {
      console.error("Realtime session API error:", json);
      return res
        .status(resp.status)
        .json({ error: "セッションの作成に失敗しました。", details: json });
    }

    // Pass through what the client needs (id/model/client_secret)
    res.json({
      id: json.id,
      model: json.model,
      client_secret: json.client_secret,
    });
  } catch (error) {
    console.error("Failed to create realtime session:", error);
    if (error?.message?.includes("OPENAI_API_KEY")) {
      return res
        .status(500)
        .json({ error: "OPENAI_API_KEY を設定してください。" });
    }
    res.status(500).json({ error: "セッションの作成に失敗しました。" });
  }
});

app.listen(port, () => {
  console.log(`Voice agent server running on http://localhost:${port}`);
});
