#!/usr/bin/env node

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requests = [];
let createdVersionElements;

const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    requests.push({
      method: request.method,
      url: request.url,
      body: body ? JSON.parse(body) : null,
    });

    let payload = { success: true, result: { id: "route-id" } };
    if (request.method === "GET" && request.url.endsWith("/versions")) {
      payload = {
        success: true,
        data: {
          versions: [
            {
              version_id: "old-version-id",
              created_at: "2026-01-01T00:00:00.000Z",
              data: createdVersionElements,
            },
            {
              version_id: "version-id",
              created_at: "2026-09-07T00:00:00.000Z",
              data: createdVersionElements,
            },
          ],
        },
      };
    } else if (request.method === "GET") {
      payload = {
        success: true,
        data: {
          routes: [{ id: "route-id", name: "kimi-k2.7-code" }],
        },
      };
    } else if (request.method === "POST" && request.url.endsWith("/versions")) {
      createdVersionElements = JSON.parse(body).elements;
      payload = { success: true, result: { id: "route-id", elements: createdVersionElements } };
    } else if (request.method === "POST" && request.url.endsWith("/deployments")) {
      payload = { success: true, result: { deployment_id: "deployment-id" } };
    }

    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(payload));
  });
});

server.listen(0, "127.0.0.1");
await once(server, "listening");

const address = server.address();
assert.ok(address && typeof address === "object");

const child = spawn(process.execPath, ["scripts/deploy.mjs", "--file", "kimi-k2.7-code.json"], {
  cwd: rootDir,
  env: {
    ...process.env,
    CLOUDFLARE_API_BASE: `http://127.0.0.1:${address.port}`,
    CLOUDFLARE_API_TOKEN: "test-token",
    CLOUDFLARE_ACCOUNT_ID: "account-id",
    CLOUDFLARE_GATEWAY_ID: "gateway-id",
    OLLAMA_CUSTOM_PROVIDER_SLUG: "ollama",
    OPENCODE_GO_CUSTOM_PROVIDER_SLUG: "opencode-go",
    COMMAND_CODE_GOAT_CUSTOM_PROVIDER_SLUG: "commandcode",
    SAKURA_AI_CUSTOM_PROVIDER_SLUG: "sakura-ai",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stderr.on("data", (chunk) => {
  output += chunk;
});

const [exitCode] = await once(child, "close");
server.close();
await once(server, "close");

assert.equal(exitCode, 0, output);
assert.deepEqual(
  requests.map(({ method, url }) => [method, url]),
  [
    ["GET", "/accounts/account-id/ai-gateway/gateways/gateway-id/routes?page=1&per_page=50"],
    ["POST", "/accounts/account-id/ai-gateway/gateways/gateway-id/routes/route-id/versions"],
    ["GET", "/accounts/account-id/ai-gateway/gateways/gateway-id/routes/route-id/versions"],
    ["POST", "/accounts/account-id/ai-gateway/gateways/gateway-id/routes/route-id/deployments"],
  ],
);

const versionRequest = requests[1];
assert.equal(versionRequest.body.elements.find(({ id }) => id === "split").type, "percentage");
assert.deepEqual(requests[3].body, { version_id: "version-id" });

const creationRequests = [];
const creationServer = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    creationRequests.push({
      method: request.method,
      url: request.url,
      body: body ? JSON.parse(body) : null,
    });

    const payload = request.method === "GET"
      ? { success: true, data: { routes: [] } }
      : { success: true, result: { id: "new-route-id" } };
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(payload));
  });
});

creationServer.listen(0, "127.0.0.1");
await once(creationServer, "listening");

const creationAddress = creationServer.address();
assert.ok(creationAddress && typeof creationAddress === "object");

const creationChild = spawn(process.execPath, ["scripts/deploy.mjs", "--file", "kimi-k2.7-code.json"], {
  cwd: rootDir,
  env: {
    ...process.env,
    CLOUDFLARE_API_BASE: `http://127.0.0.1:${creationAddress.port}`,
    CLOUDFLARE_API_TOKEN: "test-token",
    CLOUDFLARE_ACCOUNT_ID: "account-id",
    CLOUDFLARE_GATEWAY_ID: "gateway-id",
    OLLAMA_CUSTOM_PROVIDER_SLUG: "ollama",
    OPENCODE_GO_CUSTOM_PROVIDER_SLUG: "opencode-go",
    COMMAND_CODE_GOAT_CUSTOM_PROVIDER_SLUG: "commandcode",
    SAKURA_AI_CUSTOM_PROVIDER_SLUG: "sakura-ai",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let creationOutput = "";
creationChild.stdout.on("data", (chunk) => {
  creationOutput += chunk;
});
creationChild.stderr.on("data", (chunk) => {
  creationOutput += chunk;
});

const [creationExitCode] = await once(creationChild, "close");
creationServer.close();
await once(creationServer, "close");

assert.equal(creationExitCode, 0, creationOutput);
assert.deepEqual(
  creationRequests.map(({ method, url }) => [method, url]),
  [
    ["GET", "/accounts/account-id/ai-gateway/gateways/gateway-id/routes?page=1&per_page=50"],
    ["POST", "/accounts/account-id/ai-gateway/gateways/gateway-id/routes"],
  ],
);
assert.equal(creationRequests[1].body.name, "kimi-k2.7-code");
assert.equal(creationRequests[1].body.elements.length, 11);

console.log("deploy flow tests passed");
