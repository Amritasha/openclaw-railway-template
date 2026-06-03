import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import httpProxy from "http-proxy";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const INTERNAL_PORT = parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const INTERNAL_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const STATE_DIR = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
const WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR?.trim() || path.join(STATE_DIR, "workspace");
const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || crypto.randomBytes(32).toString("hex");
const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY || "/usr/local/lib/node_modules/openclaw/dist/entry.js";

// Derive the public origin from Railway env vars so the gateway allows it
const PUBLIC_DOMAIN =
  process.env.RAILWAY_PUBLIC_DOMAIN ||
  process.env.RAILWAY_STATIC_URL ||
  `localhost:${PORT}`;
const PUBLIC_ORIGIN = PUBLIC_DOMAIN.startsWith("http") ? PUBLIC_DOMAIN : `https://${PUBLIC_DOMAIN}`;

const SESSIONS = new Map();
let gatewayReady = false;
let gatewayProc = null;

function log(level, msg) {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}

function ensureDirs() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

function writeGatewayConfig() {
  const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(STATE_DIR, "openclaw.json");
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch {}

  cfg.gateway = cfg.gateway ?? {};

  // Write the gateway token into config
  cfg.gateway.token = GATEWAY_TOKEN;

  // Ensure our public origin is in the allowed list
  cfg.gateway.controlUi = cfg.gateway.controlUi ?? {};
  const existing = cfg.gateway.controlUi.allowedOrigins ?? [];
  if (!existing.includes(PUBLIC_ORIGIN)) {
    cfg.gateway.controlUi.allowedOrigins = [...existing, PUBLIC_ORIGIN];
    log("INFO", `Allowed origin added to config: ${PUBLIC_ORIGIN}`);
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

function startGateway() {
  ensureDirs();
  writeGatewayConfig();
  log("INFO", `Starting openclaw gateway on port ${INTERNAL_PORT}`);

  const env = {
    ...process.env,
    OPENCLAW_GATEWAY_PORT: String(INTERNAL_PORT),
    OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
    OPENCLAW_STATE_DIR: STATE_DIR,
    OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
  };

  gatewayProc = spawn(process.execPath, [OPENCLAW_ENTRY, "gateway", "run", "--force", "--allow-unconfigured"], { env, stdio: "inherit" });

  gatewayProc.on("exit", (code) => {
    log("WARN", `Gateway exited with code ${code}, restarting in 5s`);
    gatewayReady = false;
    setTimeout(startGateway, 5000);
  });

  // Poll until gateway responds
  const poll = setInterval(() => {
    const req = http.get({ host: INTERNAL_HOST, port: INTERNAL_PORT, path: "/" }, (res) => {
      if (res.statusCode < 500) {
        gatewayReady = true;
        log("INFO", "Gateway is ready");
        clearInterval(poll);
      }
    });
    req.on("error", () => {});
    req.end();
  }, 2000);
}

function requireAuth(req, res, next) {
  if (!SETUP_PASSWORD) return next();
  const sid = req.cookies?.sid;
  if (sid && SESSIONS.has(sid)) return next();
  res.redirect("/setup/login");
}

// Minimal cookie parser (no dep)
function parseCookies(req) {
  const raw = req.headers.cookie || "";
  return Object.fromEntries(raw.split(";").map((c) => c.trim().split("=").map(decodeURIComponent)));
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use((req, _res, next) => { req.cookies = parseCookies(req); next(); });

// Health check — always public
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", gateway: gatewayReady ? "ready" : "starting" });
});

// Setup login
app.get("/setup/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/setup/login", (req, res) => {
  const { password } = req.body;
  if (!SETUP_PASSWORD || password === SETUP_PASSWORD) {
    const sid = crypto.randomBytes(24).toString("hex");
    SESSIONS.set(sid, Date.now());
    res.setHeader("Set-Cookie", `sid=${sid}; HttpOnly; Path=/; SameSite=Lax`);
    res.redirect("/setup");
  } else {
    res.redirect("/setup/login?error=1");
  }
});

app.get("/setup/logout", (req, res) => {
  const sid = req.cookies?.sid;
  if (sid) SESSIONS.delete(sid);
  res.setHeader("Set-Cookie", "sid=; HttpOnly; Path=/; Max-Age=0");
  res.redirect("/setup/login");
});

// Setup wizard pages — protected
app.use("/setup", requireAuth);
app.use("/setup", express.static(path.join(__dirname, "public")));
app.get("/setup", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "setup.html"));
});

// Setup API — protected
app.get("/setup/api/status", requireAuth, (_req, res) => {
  const configPath = path.join(STATE_DIR, "openclaw.json");
  const configured = fs.existsSync(configPath);
  res.json({ gatewayReady, configured, stateDir: STATE_DIR, gatewayToken: GATEWAY_TOKEN });
});

app.get("/setup/api/config", requireAuth, (_req, res) => {
  const configPath = path.join(STATE_DIR, "openclaw.json");
  if (!fs.existsSync(configPath)) return res.json({});
  try {
    res.json(JSON.parse(fs.readFileSync(configPath, "utf8")));
  } catch {
    res.status(500).json({ error: "Failed to read config" });
  }
});

app.post("/setup/api/config", requireAuth, (req, res) => {
  const configPath = path.join(STATE_DIR, "openclaw.json");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy everything else to openclaw gateway
const proxy = httpProxy.createProxyServer({ ws: true });
proxy.on("error", (err, _req, res) => {
  if (res.writeHead) res.writeHead(502).end("Gateway not ready yet. Please wait...");
});

app.use((req, res) => {
  if (!gatewayReady) {
    return res.status(503).sendFile(path.join(__dirname, "public", "loading.html"));
  }
  proxy.web(req, res, { target: `http://${INTERNAL_HOST}:${INTERNAL_PORT}` });
});

const server = http.createServer(app);

// WebSocket proxy
server.on("upgrade", (req, socket, head) => {
  if (gatewayReady) {
    proxy.ws(req, socket, head, { target: `http://${INTERNAL_HOST}:${INTERNAL_PORT}` });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  log("INFO", `Wrapper listening on port ${PORT}`);
  startGateway();
});
