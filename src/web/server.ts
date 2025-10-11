// src/web/server.ts
import express, { Express, Request, Response } from "express";
import path from "path";
import { startBot, stopBot, getStatus, startBotNonInteractive } from "../telegram/client";

const app: Express = express();
const PORT = 3000;

export function startWebServer(): void {
  // Serve static files from the 'public' directory
  app.use(express.static(path.join(__dirname, "../../public")));

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


