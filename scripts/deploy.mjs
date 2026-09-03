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
const CF_ROUTE_ALREADY_EXISTS_CODE = "7005";

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

  if (!response.ok || (!Array.isArray(data) && !data.success)) {
    const errorMsg = data.errors?.map((e) => `[${e.code}] ${e.message}`).join(", ") || response.statusText;
    throw new Error(`Cloudflare API Error (${response.status}): ${errorMsg}`);
  }

  return data;
}

function extractRoutes(data) {
  if (Array.isArray(data)) {
    return data;
  }
  if (Array.isArray(data?.data?.routes)) {
    return data.data.routes;
  }
  if (Array.isArray(data?.result)) {
    return data.result;
  }
  if (Array.isArray(data?.result?.routes)) {
    return data.result.routes;
  }
  if (Array.isArray(data?.routes)) {
    return data.routes;
  }
  return [];
}

function getRoutesEndpoint(accountId, gatewayId, routeId = null) {
  const base = `/accounts/${accountId}/ai-gateway/gateways/${gatewayId}/routes`;
  return routeId ? `${base}/${routeId}` : base;
}

async function getExistingRoutes(accountId, gatewayId) {
  try {
    const allRoutes = [];
    let page = 1;
    const perPage = 50;
    const maxPages = 100;

    while (page <= maxPages) {
      const endpoint = `${getRoutesEndpoint(accountId, gatewayId)}?page=${page}&per_page=${perPage}`;
      const data = await cfRequest(endpoint);
      const routes = extractRoutes(data);

      allRoutes.push(...routes);

      const totalPages = data.result_info?.total_pages;
      if (typeof totalPages === "number") {
        if (page >= totalPages || routes.length === 0) {
          break;
        }
      } else if (routes.length < perPage) {
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

async function createRoute(accountId, gatewayId, routeName, payload) {
  console.log(`✨ Creating new route "${routeName}"...`);
  const data = await cfRequest(getRoutesEndpoint(accountId, gatewayId), {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const routeResult = data.result || data;
  console.log(`✅ Successfully created route "${routeName}" (ID: ${routeResult?.id || "unknown"})`);
  return routeResult;
}

async function updateRoute(accountId, gatewayId, routeId, routeName, payload) {
  console.log(`🔄 Updating existing route "${routeName}" (ID: ${routeId})...`);
  const data = await cfRequest(getRoutesEndpoint(accountId, gatewayId, routeId), {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  const routeResult = data.result || data;
  console.log(`✅ Successfully updated route "${routeName}" (ID: ${routeResult?.id || routeId})`);
  return routeResult;
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

    const existing = existingRoutes.find((r) => r?.name === routeName);

    try {
      if (existing?.id) {
        await updateRoute(accountId, gatewayId, existing.id, routeName, payload);
      } else {
        try {
          const created = await createRoute(accountId, gatewayId, routeName, payload);
          if (created) {
            existingRoutes.push(created);
          }
        } catch (postErr) {
          const errMsg = String(postErr?.message || "").toLowerCase();
          if (errMsg.includes("already exists") || errMsg.includes(CF_ROUTE_ALREADY_EXISTS_CODE)) {
            console.log(`⚠️ Route "${routeName}" already exists on gateway. Falling back to update (PATCH)...`);
            const refreshedRoutes = await getExistingRoutes(accountId, gatewayId);
            existingRoutes = refreshedRoutes;
            const found = refreshedRoutes.find((r) => r?.name === routeName);
            if (found?.id) {
              await updateRoute(accountId, gatewayId, found.id, routeName, payload);
            } else {
              throw postErr;
            }
          } else {
            throw postErr;
          }
        }
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
