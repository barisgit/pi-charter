/**
 * Centralized logging for pi-charter.
 *
 * Delegates file writes to pi-extension-utils `createLogger`, which writes to
 * `getAgentDir()/log/pi-charter.log` (or `dirname(PI_CHARTER_LOG_PATH)`) with
 * size-based rotation. Never writes to stdout/stderr: those streams belong to
 * the Pi TUI/runtime. Logging failures are swallowed so diagnostics never break
 * charter handling.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createLogger } from "pi-extension-utils";
import { dirname, join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  charterId?: string;
  component?: string;
  [key: string]: unknown;
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  context?: LogContext;
  error?: Error;
  timestamp: Date;
}

type LogHandler = (entry: LogEntry) => void;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const dirOverride = process.env.PI_CHARTER_LOG_PATH?.trim()
  ? dirname(process.env.PI_CHARTER_LOG_PATH.trim())
  : undefined;
const LOG_DIR = dirOverride ?? join(getAgentDir(), "log");
const LOG_PATH = join(LOG_DIR, "pi-charter.log");

// Single utils-backed file logger. Level is 'debug' so our shouldLog() stays the
// single gate (no double-filtering); utils supplies the ISO timestamp + level.
const fileLogger = createLogger("pi-charter", {
  level: "debug",
  ...(dirOverride ? { dir: dirOverride } : {}),
});

class Logger {
  private minLevel: LogLevel = "info";
  private handlers: LogHandler[] = [];
  private defaultContext: LogContext = {};

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  setDefaultContext(context: LogContext): void {
    this.defaultContext = context;
  }

  addHandler(handler: LogHandler): void {
    this.handlers.push(handler);
  }

  clearHandlers(): void {
    this.handlers = [];
  }

  logPath(): string {
    return LOG_PATH;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.minLevel];
  }

  private emit(level: LogLevel, message: string, context?: LogContext, error?: Error): void {
    if (!this.shouldLog(level)) return;
    const entry: LogEntry = {
      level,
      message,
      context: { ...this.defaultContext, ...context },
      error,
      timestamp: new Date(),
    };
    appendEntryToFile(entry);
    for (const handler of this.handlers) {
      try {
        handler(entry);
      } catch {
        // Ignore handler errors.
      }
    }
  }

  debug(message: string, context?: LogContext): void {
    this.emit("debug", message, context);
  }

  info(message: string, context?: LogContext): void {
    this.emit("info", message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.emit("warn", message, context);
  }

  error(message: string, error?: Error, context?: LogContext): void {
    this.emit("error", message, context, error);
  }

  child(context: LogContext): ChildLogger {
    return new ChildLogger(this, context);
  }
}

class ChildLogger {
  constructor(
    private parent: Logger,
    private context: LogContext,
  ) {}

  debug(message: string, context?: LogContext): void {
    this.parent.debug(message, { ...this.context, ...context });
  }

  info(message: string, context?: LogContext): void {
    this.parent.info(message, { ...this.context, ...context });
  }

  warn(message: string, context?: LogContext): void {
    this.parent.warn(message, { ...this.context, ...context });
  }

  error(message: string, error?: Error, context?: LogContext): void {
    this.parent.error(message, error, { ...this.context, ...context });
  }

  child(context: LogContext): ChildLogger {
    return new ChildLogger(this.parent, { ...this.context, ...context });
  }
}

function appendEntryToFile(entry: LogEntry): void {
  try {
    fileLogger[entry.level](formatBody(entry));
  } catch {
    // Logging must never disrupt the pi TUI/runtime.
  }
}

function formatBody(entry: LogEntry): string {
  const contextStr = formatContext(entry.context);
  const message = contextStr ? `${entry.message} ${contextStr}` : entry.message;
  const error = entry.error ? ` ${entry.error.stack ?? entry.error.message}` : "";
  return `${message}${error}`;
}

function formatContext(context?: LogContext): string {
  if (!context || Object.keys(context).length === 0) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  return parts.length > 0 ? `(${parts.join(", ")})` : "";
}

export const logger = new Logger();

if (process.env.PI_CHARTER_DEBUG === "1" || process.env.PI_CHARTER_DEBUG === "true") {
  logger.setLevel("debug");
}
