import cookieParser from "cookie-parser";
import express, { type Express } from "express";
import pinoHttp from "pino-http";
import type { AppConfig } from "@/config";
import { attachAuth } from "@/middleware/auth";
import { errorHandler, notFoundHandler } from "@/middleware/error-handler";
import { createLimiter } from "@/middleware/rate-limit";
import { requestContext } from "@/middleware/request-context";
import { corsMiddleware, originGuard, securityHeaders } from "@/middleware/security";
import { createApiRouter } from "@/routes";
import { getLogger } from "@/utils/logger";
import type { Container } from "@/container";

export function createApp(container: Container): Express {
  const { config } = container;
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);

  app.use(requestContext);
  app.use(
    pinoHttp({
      logger: getLogger(),
      genReqId: (req) => (req as express.Request).id,
      customProps: (req) => ({ userId: (req as express.Request).auth?.user.id }),
      // Keep logs small and free of cookies/bodies; redaction in the logger is a second layer.
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url.split("?")[0] }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => req.url === "/health" },
    }),
  );
  app.use(securityHeaders());
  app.use(corsMiddleware(config));
  app.use(cookieParser());
  // Admin endpoints accept larger payloads (manually authored challenges).
  app.use("/api/v1/admin", express.json({ limit: "1mb" }));
  app.use(express.json({ limit: "100kb" }));
  app.use(originGuard(config));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", uptimeSeconds: Math.round(process.uptime()) });
  });

  app.use(createLimiter({ windowMs: 60_000, limit: config.rateLimits.apiPerMinute, perUser: false }));
  app.use("/api/v1", attachAuth(config), createApiRouter(container));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export type { AppConfig };
