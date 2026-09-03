import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const routesDir = path.resolve(rootDir, "routes");

const isDryRun = process.argv.includes("--dry-run");
const fileArgIndex = process.argv.indexOf("--file");
let targetFile = null;
if (fileArgIndex !== -1) {
  const nextArg = process.argv[fileArgIndex + 1];
  if (!nextArg || nextArg.startsWith("-")) {
    console.error("❌ Error: --file option requires a valid file path argument.");
    process.exit(1);
  }
  targetFile = nextArg;
}

function getRouteFiles() {
  if (targetFile) {
    if (path.isAbsolute(targetFile)) return [targetFile];
    if (fs.existsSync(path.resolve(routesDir, targetFile))) {
      return [path.resolve(routesDir, targetFile)];
    }
    return [path.resolve(rootDir, targetFile)];
  }

  if (fs.existsSync(routesDir)) {
    return fs
      .readdirSync(routesDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => path.resolve(routesDir, f));
  }

  return [];
}

const CF_API_BASE = process.env.CLOUDFLARE_API_BASE || "https://api.cloudflare.com/client/v4";

function checkEnv() {
  const required = [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_GATEWAY_ID",
  ];

  const providerSlugs = [
    "OLLAMA_CUSTOM_PROVIDER_SLUG",
    "OPENCODE_GO_CUSTOM_PROVIDER_SLUG",
    "COMMAND_CODE_GOAT_CUSTOM_PROVIDER_SLUG",
  ];

  if (!isDryRun) {
    const missing = [...required, ...providerSlugs].filter((key) => !process.env[key]);
    if (missing.length > 0) {
      console.error(`❌ Error: Missing required environment variable(s): ${missing.join(", ")}`);
      process.exit(1);
    }
  }
}

function replacePlaceholders(jsonString) {
  const replacements = {
    REPLACE_WITH_OLLAMA_CUSTOM_PROVIDER_SLUG: process.env.OLLAMA_CUSTOM_PROVIDER_SLUG || "ollama-placeholder",
    REPLACE_WITH_OPENCODE_GO_CUSTOM_PROVIDER_SLUG: process.env.OPENCODE_GO_CUSTOM_PROVIDER_SLUG || "opencode-go-placeholder",
    REPLACE_WITH_COMMAND_CODE_GOAT_CUSTOM_PROVIDER_SLUG: process.env.COMMAND_CODE_GOAT_CUSTOM_PROVIDER_SLUG || "goat-placeholder",
  };

  let result = jsonString;
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.replaceAll(placeholder, value);
  }
  return result;
}

async function cfRequest(endpoint, options = {}) {
  const url = `${CF_API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  let data;
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok || !data.success) {
    const errorMsg = data.errors?.map((e) => `[${e.code}] ${e.message}`).join(", ") || response.statusText;
    throw new Error(`Cloudflare API Error (${response.status}): ${errorMsg}`);
  }

  return data;
}

async function getExistingRoutes(accountId, gatewayId) {
  try {
    const allRoutes = [];
    let page = 1;
    const perPage = 50;

    while (true) {
      const data = await cfRequest(
        `/accounts/${accountId}/ai-gateway/gateways/${gatewayId}/routes?page=${page}&per_page=${perPage}`
      );
      const res = data.result;
      const routes = Array.isArray(res)
        ? res
        : Array.isArray(res?.routes)
        ? res.routes
        : Array.isArray(data.routes)
        ? data.routes
        : [];

      allRoutes.push(...routes);

      const totalPages = data.result_info?.total_pages;
      if (!totalPages || page >= totalPages || routes.length === 0) {
        break;
      }
      page++;
    }

    return allRoutes;
  } catch (err) {
    console.error(`Failed to fetch existing routes: ${err.message}`);
    throw err;
  }
}

async function main() {
  console.log(`🚀 Starting Cloudflare AI Gateway Dynamic Routing Deployment...`);
  if (isDryRun) {
    console.log(`🔍 Mode: DRY-RUN (No changes will be applied)`);
  }

  checkEnv();

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const gatewayId = process.env.CLOUDFLARE_GATEWAY_ID;

  let existingRoutes = [];
  if (!isDryRun) {
    console.log(`📡 Fetching existing routes for gateway "${gatewayId}"...`);
    existingRoutes = await getExistingRoutes(accountId, gatewayId);
    console.log(`ℹ️  Found ${existingRoutes.length} existing route(s) in gateway.`);
  }

  const filesToDeploy = getRouteFiles();

  if (filesToDeploy.length === 0) {
    console.warn("⚠️  No route files found to deploy.");
    return;
  }

  let successCount = 0;
  let failCount = 0;

  for (const filePath of filesToDeploy) {
    if (!fs.existsSync(filePath)) {
      console.error(`❌ File not found: ${filePath}`);
      failCount++;
      continue;
    }

    console.log(`\n📄 Processing ${path.basename(filePath)}...`);
    const rawContent = fs.readFileSync(filePath, "utf8");
    const processedContent = replacePlaceholders(rawContent);

    let routeData;
    try {
      routeData = JSON.parse(processedContent);
    } catch (e) {
      console.error(`❌ JSON parse error in ${path.basename(filePath)}: ${e.message}`);
      failCount++;
      continue;
    }

    if (!routeData || typeof routeData !== "object") {
      console.error(`❌ Invalid route content in ${path.basename(filePath)}: expected a JSON object.`);
      failCount++;
      continue;
    }

    const routeName = routeData.name;
    const elements = routeData.elements;

    if (!routeName || !Array.isArray(elements)) {
      console.error(`❌ Invalid route format in ${path.basename(filePath)}: "name" and "elements" array are required.`);
      failCount++;
      continue;
    }

    const payload = {
      name: routeName,
      elements: elements,
    };

    if (isDryRun) {
      console.log(`[DRY-RUN] Route name: "${routeName}" with ${elements.length} element(s).`);
      console.log(`[DRY-RUN] Payload preview (elements count: ${elements.length}):`);
      console.log(JSON.stringify(payload, null, 2).slice(0, 300) + "\n...");
      successCount++;
      continue;
    }

    const existing = existingRoutes.find((r) => r.name === routeName);

    try {
      if (existing) {
        console.log(`🔄 Updating existing route "${routeName}" (ID: ${existing.id})...`);
        const data = await cfRequest(
          `/accounts/${accountId}/ai-gateway/gateways/${gatewayId}/routes/${existing.id}`,
          {
            method: "PATCH",
            body: JSON.stringify(payload),
          }
        );
        const routeResult = data.result || data;
        console.log(`✅ Successfully updated route "${routeName}" (ID: ${routeResult.id || existing.id})`);
      } else {
        console.log(`✨ Creating new route "${routeName}"...`);
        const data = await cfRequest(
          `/accounts/${accountId}/ai-gateway/gateways/${gatewayId}/routes`,
          {
            method: "POST",
            body: JSON.stringify(payload),
          }
        );
        const routeResult = data.result || data;
        console.log(`✅ Successfully created route "${routeName}" (ID: ${routeResult.id})`);
      }
      successCount++;
    } catch (err) {
      console.error(`❌ Failed to deploy route "${routeName}": ${err.message}`);
      failCount++;
    }
  }

  console.log(`\n========================================`);
  console.log(`📊 Deployment Summary: ${successCount} succeeded, ${failCount} failed`);
  console.log(`========================================`);

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`❌ Unexpected error:`, err);
  process.exit(1);
});
