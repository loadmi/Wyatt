// src/web/server.ts
import express, { Express, Request, Response } from "express";
import path from "path";
import { startBot, stopBot, getStatus, startBotNonInteractive } from "../telegram/client";

import { appConfig, setConfig } from "../config";
import { availableJsonFiles } from "../llm/personas/personalities";

const app: Express = express();
const PORT = 8080;

export function startWebServer(): void {
  // Serve static files from the 'public' directory
  app.use(express.static(path.join(__dirname, "../../public")));

  // Add JSON body parser middleware
  app.use(express.json());

  app.get("/api/status", (req: Request, res: Response) => {
    res.json(getStatus());
  });

  app.post("/api/start", async (req: Request, res: Response) => {
    const result = await startBot();
    res.status(result.success ? 200 : 500).json(result);
  });

  app.post("/api/stop", async (req: Request, res: Response) => {
    const result = await stopBot();
    res.status(result.success ? 200 : 500).json(result);
  });

  app.post("/api/config/persona", async (req: Request, res: Response) => {
    const { persona } = req.body;
    const newConfig = appConfig();
    const availablePersonalities = availableJsonFiles;


    if (!persona || typeof persona !== "string" || !availablePersonalities.includes(persona)) {
      return res.status(400).json({ success: false, message: "Invalid persona." });
    }
    const importedPersona = await import(`../llm/personas/${persona}`, { with: { type: "json" } }).then(mod => mod.default);
    newConfig.systemPrompt = JSON.stringify(importedPersona);
    setConfig(newConfig);
    res.status(201).json({ success: true, persona });
  });

  app.get("/api/config/personas", async (req: Request, res: Response) => {
    const newConfig = appConfig();
    const availablePersonalities = availableJsonFiles;
    res.json({ available: availablePersonalities, current: newConfig.systemPrompt });
  });

  // LLM provider + model configuration
  app.get("/api/config/llm", async (req: Request, res: Response) => {
    const cfg = appConfig() as any;
    const hasOpenrouterKey = !!(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim());
    // A small curated list of common OpenRouter models (can be extended)
    const availableOpenRouterModels = [
      "google/gemini-2.0-flash-001",
      "google/gemini-2.5-flash-lite-preview-09-2025",
      "mistralai/mistral-nemo",
    ];
    res.json({
      provider: cfg.llmProvider || 'pollinations',
      openrouterModel: cfg.openrouterModel || 'google/gemini-2.0-flash-001',
      hasOpenrouterKey,
      availableOpenRouterModels,
    });
  });

  app.post("/api/config/llm", async (req: Request, res: Response) => {
    const { provider, openrouterModel } = req.body || {};
    const allowedProviders = ["pollinations", "openrouter"];
    if (!allowedProviders.includes(provider)) {
      return res.status(400).json({ success: false, message: "Invalid provider" });
    }
    const current = appConfig() as any;
    const next = { ...current };
    next.llmProvider = provider;
    if (provider === 'openrouter') {
      if (typeof openrouterModel === 'string' && openrouterModel.trim().length > 0) {
        next.openrouterModel = openrouterModel.trim();
      }
    }
    setConfig(next);
    res.status(201).json({ success: true, provider: next.llmProvider, openrouterModel: next.openrouterModel });
  });

  app.listen(PORT, async () => {
    console.log(`Web interface running at http://localhost:${PORT}`);

    // Attempt to auto-start the bot if a valid session is present.
    const hasSession = !!(process.env.SESSION_STRING && process.env.SESSION_STRING.trim());
    if (hasSession) {
      try {
        const result = await startBotNonInteractive();
        if (result.success) {
          console.log("Auto-start: bot is running using existing session.");
        } else {
          console.log(result.message);
        }
      } catch (err: any) {
        console.log("Auto-start failed:", err?.message || String(err));
      }
    } else {
      console.log("Auto-start skipped: no SESSION_STRING configured.");
    }
  });
}
