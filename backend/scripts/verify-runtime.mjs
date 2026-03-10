import { readdir } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, "..");
const srcDir = path.join(backendDir, "src");
async function listJsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listJsFiles(fullPath);
      }
      return entry.name.endsWith(".js") ? [fullPath] : [];
    }),
  );
  return files.flat();
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function pickPort() {
  const server = net.createServer();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to determine free port")));
        return;
      }
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function syntaxCheck() {
  const files = await listJsFiles(srcDir);
  for (const file of files) {
    execFileSync(process.execPath, ["--check", file], {
      cwd: backendDir,
      stdio: "pipe",
    });
  }
  console.log(`syntax-ok ${files.length} files`);
}

async function fetchHealth(port) {
  const urls = [
    `http://127.0.0.1:${port}/health`,
    `http://localhost:${port}/health`,
    `http://[::1]:${port}/health`,
  ];

  let lastError = null;

  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Health check failed with status ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Health check failed");
}

async function waitForHealthy(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      return await fetchHealth(port);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error(`Timed out waiting for backend health: ${lastError?.message ?? "unknown error"}`);
}

async function stopChild(child) {
  if (!child || child.killed) return;

  child.kill("SIGINT");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 3000);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function verifyRuntime() {
  await syntaxCheck();

  const port = await pickPort();

  const env = {
    ...process.env,
    BACKEND_PORT: String(port),
    BACKEND_ALLOW_NONSTANDARD_PORTS: "true",
  };

  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: backendDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stderr.write(text);
  });

  try {
    const health = await waitForHealthy(port);
    if (health?.status !== "healthy" || health?.service !== "iconsai-scraping-backend") {
      throw new Error(`Unexpected health payload: ${JSON.stringify(health)}`);
    }
    console.log(`health-ok port=${port} mode=spawn`);
  } finally {
    await stopChild(child);
  }

  if (child.exitCode && child.exitCode !== 0) {
    throw new Error(`Backend exited with code ${child.exitCode}\n${output}`);
  }
}

verifyRuntime().catch((error) => {
  console.error(`backend-verify-failed: ${error.message}`);
  process.exit(1);
});
