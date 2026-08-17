import assert from "node:assert/strict";
import test from "node:test";
import {
  acknowledgeSyncEvent,
  activatePluginVault,
  PluginApiError,
  loadCaptureStatuses,
  loadIdentityAndTargets,
  loadSyncEvents,
} from "../src/client.ts";

const token = `ikt1_${"F".repeat(43)}`;
const projectId = "20000000-0000-4000-8000-000000000001";
const deviceId = "30000000-0000-4000-8000-000000000001";
const activationId = "25000000-0000-4000-8000-000000000001";
const fetchTransport = async (url, init) => {
  const response = await fetch(url, init);
  return {
    status: response.status,
    json: await response.json().catch(() => null),
  };
};

test("plugin verifies the token before loading activated Vault targets", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({
      path: new URL(request.url).pathname,
      authorization: request.headers.get("authorization"),
    });
    return new URL(request.url).pathname === "/v1/whoami"
      ? Response.json({ owner: { id: "owner-1", anonymous: false } })
      : Response.json([{ id: projectId, name: "Research", status: "active" }]);
  };

  try {
    const result = await loadIdentityAndTargets(
      "https://api.example",
      token,
      fetchTransport,
    );
    assert.deepEqual(result.targets, [
      { id: projectId, name: "Research", status: "active" },
    ]);
    assert.deepEqual(requests, [
      { path: "/v1/whoami", authorization: `Bearer ${token}` },
      { path: "/v1/targets", authorization: `Bearer ${token}` },
    ]);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Vault activation creates or reuses the Project without sending a path", async () => {
  let request;
  const bindingId = "40000000-0000-4000-8000-000000000001";
  const activation = await activatePluginVault(
    {
      apiUrl: "https://api.example",
      token,
      activationId,
      projectId,
      deviceId,
      vaultName: "My Vault",
    },
    async (url, init) => {
      request = { url, ...init, body: JSON.parse(init.body) };
      return {
        status: 201,
        json: {
          project: { id: projectId, name: "My Vault", status: "active" },
          binding: {
            id: bindingId,
            projectId,
            deviceId,
            vaultName: "My Vault",
          },
        },
      };
    },
  );

  assert.equal(activation.binding.id, bindingId);
  assert.deepEqual(request.body, {
    projectId,
    activationId,
    deviceId,
    vaultName: "My Vault",
  });
  assert.ok(Object.keys(request.body).every((key) => !/path/i.test(key)));
  assert.equal(request.url, "https://api.example/v1/vault-activations");
});

test("sync feed and acknowledgement stay scoped to Project and binding", async () => {
  const eventId = "60000000-0000-4000-8000-000000000001";
  const bindingId = "40000000-0000-4000-8000-000000000001";
  const requests = [];
  const transport = async (url, init) => {
    requests.push({ url, method: init.method, body: init.body });
    return url.endsWith("/ack")
      ? {
          status: 200,
          json: { id: eventId, acknowledgedAt: "2026-08-06T04:01:00Z" },
        }
      : {
          status: 200,
          json: [
            {
              id: eventId,
              projectId,
              captureId: "50000000-0000-4000-8000-000000000001",
              payloadVersion: 1,
              markdown: "---\ncapture_id: test\n---\n\nA note\n",
              createdAt: "2026-08-06T04:00:00Z",
            },
          ],
        };
  };

  const events = await loadSyncEvents(
    { apiUrl: "https://api.example", token, projectId, bindingId },
    transport,
  );
  await acknowledgeSyncEvent(
    { apiUrl: "https://api.example", token, eventId, bindingId },
    transport,
  );
  assert.equal(events[0].projectId, projectId);
  assert.deepEqual(requests, [
    {
      url: `https://api.example/v1/projects/${projectId}/sync-events?bindingId=${bindingId}`,
      method: "GET",
      body: undefined,
    },
    {
      url: `https://api.example/v1/sync-events/${eventId}/ack`,
      method: "POST",
      body: JSON.stringify({ bindingId }),
    },
  ]);
});

test("cloud Capture status feed stays scoped to Project and binding", async () => {
  const bindingId = "40000000-0000-4000-8000-000000000001";
  const requests = [];
  const transport = async (url, init) => {
    requests.push({ url, method: init.method, body: init.body });
    return {
      status: 200,
      json: [
        {
          id: "50000000-0000-4000-8000-000000000001",
          projectId,
          kind: "url",
          sourceUrl: "https://example.com/article",
          client: "browser-extension",
          capturedAt: "2026-08-06T04:00:00Z",
          processingMode: "cloud",
          status: "processing",
          failureReason: null,
        },
      ],
    };
  };

  const statuses = await loadCaptureStatuses(
    { apiUrl: "https://api.example", token, projectId, bindingId },
    transport,
  );

  assert.equal(statuses[0].status, "processing");
  assert.deepEqual(requests, [
    {
      url: `https://api.example/v1/projects/${projectId}/capture-statuses?bindingId=${bindingId}`,
      method: "GET",
      body: undefined,
    },
  ]);
});

test("sync stops with recovery when the token or Project becomes invalid", async () => {
  const bindingId = "40000000-0000-4000-8000-000000000001";
  await assert.rejects(
    loadSyncEvents(
      { apiUrl: "https://api.example", token, projectId, bindingId },
      async () => ({
        status: 401,
        json: { error: { code: "invalid_token", message: "rotated" } },
      }),
    ),
    (error) =>
      error instanceof PluginApiError &&
      error.code === "invalid_token" &&
      /valid token/i.test(error.recovery),
  );
  await assert.rejects(
    loadSyncEvents(
      { apiUrl: "https://api.example", token, projectId, bindingId },
      async () => ({
        status: 404,
        json: {
          error: { code: "project_not_found", message: "deleted" },
        },
      }),
    ),
    (error) =>
      error instanceof PluginApiError &&
      error.code === "project_not_found" &&
      /active Project/i.test(error.recovery),
  );
});

test("invalid tokens return anonymous recovery guidance", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      { error: { code: "invalid_token", message: "invalid" } },
      { status: 401 },
    );

  try {
    await assert.rejects(
      loadIdentityAndTargets("https://api.example", token, fetchTransport),
      (error) =>
        error instanceof PluginApiError &&
        error.code === "invalid_token" &&
        /anonymous identity cannot be recovered/i.test(error.recovery),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("non-token failures keep valid credentials and give relevant recovery", async () => {
  await assert.rejects(
    activatePluginVault(
      {
        apiUrl: "https://api.example",
        token,
        activationId,
        projectId,
        deviceId,
        vaultName: "My Vault",
      },
      async () => ({
        status: 409,
        json: {
          error: { code: "project_unavailable", message: "disabled" },
        },
      }),
    ),
    (error) =>
      error instanceof PluginApiError &&
      /active Project/i.test(error.recovery) &&
      !/new token|anonymous identity/i.test(error.recovery),
  );
  await assert.rejects(
    loadIdentityAndTargets("https://api.example", token, async () => ({
      status: 502,
      json: { error: { code: "identity_store_failed", message: "failed" } },
    })),
    (error) =>
      error instanceof PluginApiError &&
      /service status/i.test(error.recovery) &&
      !/new token|anonymous identity/i.test(error.recovery),
  );
});

test("plugin refuses to send a token over insecure remote HTTP", async () => {
  await assert.rejects(
    loadIdentityAndTargets("http://api.example", token),
    (error) =>
      error instanceof PluginApiError && error.code === "insecure_api_url",
  );
});

test("localhost accepts HTTP but rejects every other insecure scheme", async () => {
  await assert.rejects(
    loadIdentityAndTargets("ftp://localhost:8787", token),
    (error) =>
      error instanceof PluginApiError && error.code === "insecure_api_url",
  );
});
