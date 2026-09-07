const CF_API_BASE = process.env.CLOUDFLARE_API_BASE || "https://api.cloudflare.com/client/v4";
export const CF_ROUTE_ALREADY_EXISTS_CODE = "7005";

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

function getRouteVersionsEndpoint(accountId, gatewayId, routeId) {
  return `${getRoutesEndpoint(accountId, gatewayId, routeId)}/versions`;
}

function getRouteDeploymentsEndpoint(accountId, gatewayId, routeId) {
  return `${getRoutesEndpoint(accountId, gatewayId, routeId)}/deployments`;
}

export async function getExistingRoutes(accountId, gatewayId) {
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

function extractVersions(data) {
  if (Array.isArray(data)) {
    return data;
  }
  if (Array.isArray(data?.data?.versions)) {
    return data.data.versions;
  }
  if (Array.isArray(data?.result?.versions)) {
    return data.result.versions;
  }
  if (Array.isArray(data?.versions)) {
    return data.versions;
  }
  return [];
}

async function getRouteVersions(accountId, gatewayId, routeId) {
  const data = await cfRequest(getRouteVersionsEndpoint(accountId, gatewayId, routeId));
  return extractVersions(data);
}

function getVersionElements(version) {
  const versionData = version?.data ?? version?.elements;
  if (Array.isArray(versionData)) {
    return versionData;
  }
  if (versionData && typeof versionData === "object" && Array.isArray(versionData.elements)) {
    return versionData.elements;
  }
  if (typeof versionData === "string") {
    try {
      const parsed = JSON.parse(versionData);
      if (Array.isArray(parsed)) {
        return parsed;
      }
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.elements)) {
        return parsed.elements;
      }
    } catch {
      return null;
    }
  }
  return null;
}

async function createRouteVersion(accountId, gatewayId, routeId, elements) {
  console.log(`📝 Creating a new version for route (ID: ${routeId})...`);
  const data = await cfRequest(getRouteVersionsEndpoint(accountId, gatewayId, routeId), {
    method: "POST",
    body: JSON.stringify({ elements }),
  });
  const routeResult = data.result || data;
  const responseVersionId =
    routeResult?.version?.version_id ||
    routeResult?.version_id;
  if (responseVersionId) {
    return responseVersionId;
  }

  const versions = await getRouteVersions(accountId, gatewayId, routeId);
  const expectedElements = JSON.stringify(elements);
  const matchingVersion = versions
    .filter((version) => version?.version_id && JSON.stringify(getVersionElements(version)) === expectedElements)
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0];
  if (!matchingVersion?.version_id) {
    throw new Error(`Cloudflare API did not return the newly created version ID for route "${routeId}".`);
  }
  return matchingVersion.version_id;
}

async function deployRouteVersion(accountId, gatewayId, routeId, versionId) {
  console.log(`🚀 Deploying version "${versionId}"...`);
  return cfRequest(getRouteDeploymentsEndpoint(accountId, gatewayId, routeId), {
    method: "POST",
    body: JSON.stringify({ version_id: versionId }),
  });
}

export async function createRoute(accountId, gatewayId, routeName, payload) {
  console.log(`✨ Creating new route "${routeName}"...`);
  const data = await cfRequest(getRoutesEndpoint(accountId, gatewayId), {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const routeResult = data.result || data;
  console.log(`✅ Successfully created route "${routeName}" (ID: ${routeResult?.id || "unknown"})`);
  return routeResult;
}

export async function updateRoute(accountId, gatewayId, routeId, routeName, payload) {
  const versionId = await createRouteVersion(accountId, gatewayId, routeId, payload.elements);
  const data = await deployRouteVersion(accountId, gatewayId, routeId, versionId);
  const routeResult = data.result || data;
  console.log(`✅ Successfully updated route "${routeName}" (ID: ${routeResult?.id || routeId})`);
  return routeResult;
}
