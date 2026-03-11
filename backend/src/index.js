import dotenv from "dotenv";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";

// Load .env from parent directory (project root)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "../../.env") });

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import companiesRouter from "./routes/companies.js";
import peopleRouter from "./routes/people.js";
import newsRouter from "./routes/news.js";
import politiciansRouter from "./routes/politicians.js";
import geoRouter from "./routes/geo.js";
import atlasRouter from "./routes/atlas.js";
import peopleAgentRouter from "./routes/people-agent.js";
import statsRouter from "./routes/stats.js";
import graphRouter from "./routes/graph.js";
import emendasRouter from "./routes/emendas.js";
import dbModelRouter from "./routes/db-model.js";
import biRouter from "./routes/bi.js";
import { logger, requestLogger } from "./utils/logger.js";
import { initCache } from "./utils/cache.js";
import { requireAuth, requirePermission } from "./middleware/auth.js";
import { PERMISSIONS } from "./constants.js";
import { warmApprovedCache } from "./database/supabase.js";

export const DEFAULT_PORT = Number(process.env.BACKEND_PORT || 3006);

const ALLOWED_PORTS = [3006, 3001]; // dev=3006, prod=3001
function assertAllowedPort(port) {
  const allowNonstandardPorts =
    process.env.BACKEND_ALLOW_NONSTANDARD_PORTS === "true";
  if (!allowNonstandardPorts && !ALLOWED_PORTS.includes(Number(port))) {
    logger.error(
      `PORTA BLOQUEADA: Backend tentou iniciar na porta ${port}. Portas permitidas: ${ALLOWED_PORTS.join(", ")}`,
    );
    throw new Error(
      `Invalid backend port ${port}. Allowed ports: ${ALLOWED_PORTS.join(", ")}`,
    );
  }
}

// Rate limiter - 100 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  message: { error: "Muitas requisições. Tente novamente em 1 minuto." },
  standardHeaders: true,
  legacyHeaders: false,
});

export function createApp() {
  const app = express();

  // CORS - whitelist from ALLOWED_ORIGINS env var
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3002")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
    }),
  );
  app.use(express.json());
  app.use(requestLogger);
  app.use("/companies", limiter);
  app.use("/people", limiter);
  app.use("/news", limiter);
  app.use("/politicians", limiter);
  app.use("/geo", limiter);
  app.use("/atlas", limiter);
  app.use("/people-agent", limiter);
  app.use("/graph", limiter);
  app.use("/emendas", limiter);
  app.use("/db-model", limiter);
  app.use("/bi", limiter);

  // Routes (nginx strips /api/ prefix, so use /companies directly)
  // All data routes require JWT authentication
  // Module routes also require specific permissions
  app.use(
    "/companies",
    requireAuth,
    requirePermission(PERMISSIONS.EMPRESAS),
    companiesRouter,
  );
  app.use(
    "/people",
    requireAuth,
    requirePermission(PERMISSIONS.PESSOAS),
    peopleRouter,
  );
  app.use(
    "/news",
    requireAuth,
    requirePermission(PERMISSIONS.NOTICIAS),
    newsRouter,
  );
  app.use(
    "/politicians",
    requireAuth,
    requirePermission(PERMISSIONS.POLITICOS),
    politiciansRouter,
  );
  app.use(
    "/people-agent",
    requireAuth,
    requirePermission(PERMISSIONS.PESSOAS),
    peopleAgentRouter,
  );
  app.use(
    "/emendas",
    requireAuth,
    requirePermission(PERMISSIONS.EMENDAS),
    emendasRouter,
  );
  // Auth-only routes (no module permission required)
  app.use("/geo", requireAuth, geoRouter);
  app.use("/atlas", requireAuth, atlasRouter);
  app.use("/stats", requireAuth, statsRouter);
  app.use("/graph", requireAuth, graphRouter);
  app.use("/db-model", requireAuth, dbModelRouter);
  app.use("/bi", requireAuth, biRouter);

  // Health check
  app.get("/health", (req, res) => {
    res.json(buildHealthPayload());
  });

  // Version endpoint for deployment verification
  app.get("/version", (req, res) => {
    res.json({
      version: process.env.npm_package_version || "1.0.0",
      git_sha: process.env.GIT_SHA || "unknown",
      build_date: process.env.BUILD_DATE || "unknown",
      service: "iconsai-scraping-backend",
    });
  });

  return app;
}

export function buildHealthPayload() {
  return {
    status: "healthy",
    service: "iconsai-scraping-backend",
    timestamp: new Date().toISOString(),
    git_sha: process.env.GIT_SHA || "unknown",
    build_date: process.env.BUILD_DATE || "unknown",
    apollo_configured: !!process.env.APOLLO_API_KEY,
    fiscal_configured: !!(
      process.env.FISCAL_SUPABASE_URL && process.env.FISCAL_SUPABASE_KEY
    ),
    brasil_data_hub_configured: !!(
      process.env.BRASIL_DATA_HUB_URL && process.env.BRASIL_DATA_HUB_KEY
    ),
    atlas_llm_configured: !!(
      process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY
    ),
    redis_configured: !!process.env.REDIS_URL,
  };
}

// Startup credential validation
function validateCredentials() {
  const required = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
    SERPER_API_KEY: process.env.SERPER_API_KEY,
  };

  const optional = {
    APOLLO_API_KEY: process.env.APOLLO_API_KEY,
    CNPJA_API_KEY: process.env.CNPJA_API_KEY,
    PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    FISCAL_SUPABASE_URL: process.env.FISCAL_SUPABASE_URL,
    FISCAL_SUPABASE_KEY: process.env.FISCAL_SUPABASE_KEY,
    BRASIL_DATA_HUB_URL: process.env.BRASIL_DATA_HUB_URL,
    BRASIL_DATA_HUB_KEY: process.env.BRASIL_DATA_HUB_KEY,
  };

  const missingRequired = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const missingOptional = Object.entries(optional)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missingRequired.length > 0) {
    logger.error("Missing REQUIRED credentials - server cannot start", {
      missing: missingRequired,
    });
    throw new Error(
      `Missing required environment variables: ${missingRequired.join(", ")}. Check your .env file.`,
    );
  }

  if (missingOptional.length > 0) {
    logger.warn(
      "Missing optional credentials - some features will be unavailable",
      { missing: missingOptional },
    );
  }

  logger.info("Credential validation passed", {
    required: Object.keys(required).length,
    optional_configured: Object.keys(optional).length - missingOptional.length,
    optional_missing: missingOptional.length,
  });
}

validateCredentials();

// Initialize cache (Redis or in-memory fallback)
const cacheInitPromise = initCache()
  .then(() => {
    logger.info("Cache initialized");
  })
  .catch((err) => {
    logger.warn("Cache initialization failed, using in-memory fallback", {
      error: err.message,
    });
  });

export const app = createApp();

export async function startServer({ port = DEFAULT_PORT } = {}) {
  assertAllowedPort(port);
  await cacheInitPromise;

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      const address = server.address();
      const actualPort =
        typeof address === "object" && address ? address.port : port;

      logger.info("Backend started", {
        port: actualPort,
        apollo_configured: !!process.env.APOLLO_API_KEY,
        cnpja_configured: !!process.env.CNPJA_API_KEY,
        perplexity_configured: !!process.env.PERPLEXITY_API_KEY,
        redis_configured: !!process.env.REDIS_URL,
      });

      // Eagerly warm approved companies cache so first request is fast (~2ms vs ~10s)
      warmApprovedCache();
      resolve(server);
    });

    server.on("error", reject);
  });
}

const invokedAsEntryPoint =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsEntryPoint) {
  startServer().catch((error) => {
    logger.error("Backend failed to start", { error: error.message });
    process.exit(1);
  });
}
