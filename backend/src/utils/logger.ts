import pino, { type Logger } from "pino";
import { getConfig } from "@/config";

let root: Logger | undefined;

function create(): Logger {
  const config = getConfig();
  return pino({
    level: config.logLevel,
    base: { service: "sql-challenge-api" },
    redact: {
      paths: [
        "req.headers.cookie",
        "req.headers.authorization",
        'req.headers["x-csrf-token"]',
        'res.headers["set-cookie"]',
        "*.password",
        "*.token",
        "*.secret",
        "*.apiKey",
        "*.sessionToken",
        "*.csrfToken",
        "*.clientSecret",
        "*.idToken",
        "*.codeVerifier",
      ],
      censor: "[redacted]",
    },
    transport:
      config.env === "development"
        ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" } }
        : undefined,
  });
}

export function getLogger(): Logger {
  root ??= create();
  return root;
}

/** Lazily-initialised proxy so importing the logger never triggers config validation. */
export const logger: Logger = new Proxy({} as Logger, {
  get(_target, prop, receiver) {
    const instance = getLogger();
    const value = Reflect.get(instance, prop, receiver) as unknown;
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(instance) : value;
  },
});

export function childLogger(bindings: Record<string, unknown>): Logger {
  return getLogger().child(bindings);
}
