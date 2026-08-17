export interface Project {
  id: string;
  name: string;
  status: string;
}

export interface SyncEvent {
  id: string;
  projectId: string;
  captureId: string;
  payloadVersion: number;
  markdown: string;
  sourceUrl?: string | null;
  inputKind?: "url" | "text" | "markdown";
  processingMode?: "standard" | "cloud";
  status?: "ready" | "partial" | "failed";
  createdAt: string;
}

export type CaptureStatus =
  "accepted" | "processing" | "ready" | "partial" | "failed";

export interface CaptureStatusRecord {
  id: string;
  projectId: string;
  kind: "url" | "text" | "markdown";
  sourceUrl: string | null;
  client: string;
  capturedAt: string;
  processingMode: "standard" | "cloud";
  status: CaptureStatus;
  failureReason: string | null;
  updatedAt: string;
}

const statusLabels: Record<CaptureStatus, string> = {
  accepted: "Accepted by the cloud service",
  processing: "Cloud processing",
  ready: "Ready to sync",
  partial: "Partially complete",
  failed: "Cloud processing failed",
};

export function renderCaptureStatus(status: CaptureStatusRecord): string {
  const source = status.sourceUrl ?? "Direct submission";
  const failure = status.failureReason
    ? `\n\n> [!failure] Processing stopped\n> ${status.failureReason}\n> Share the content again to start a new Capture. If it keeps failing, contact support.`
    : "";
  return [
    "---",
    `capture_id: ${JSON.stringify(status.id)}`,
    `source_url: ${JSON.stringify(status.sourceUrl)}`,
    `captured_at: ${JSON.stringify(status.capturedAt)}`,
    `updated_at: ${JSON.stringify(status.updatedAt)}`,
    `input_kind: ${JSON.stringify(status.kind)}`,
    'processing_mode: "cloud"',
    `processing_state: ${JSON.stringify(status.status)}`,
    "---",
    "",
    `# ${statusLabels[status.status]}`,
    "",
    `- Source: ${source}`,
    `- Capture: ${status.id}`,
    `- Updated: ${status.updatedAt}`,
    failure,
    "",
  ].join("\n");
}

export interface ApiResponse {
  status: number;
  json: unknown;
}

export type ApiTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<ApiResponse>;

export class PluginApiError extends Error {
  readonly code: string;
  readonly recovery: string;

  constructor(code: string, message: string, recovery: string) {
    super(message);
    this.code = code;
    this.recovery = recovery;
  }
}

const TOKEN_RECOVERY =
  "Enter a valid token or create a new one on the website. A lost anonymous identity cannot be recovered; start a new anonymous identity or sign in.";

function recoveryFor(status: number, code: string): string {
  if (code === "invalid_token") return TOKEN_RECOVERY;
  if (code === "project_unavailable" || code === "project_not_found") {
    return "Verify the token, then choose an active Project that belongs to this identity.";
  }
  return status >= 500
    ? "Try again. If the problem continues, check the service status."
    : "Check the request and try again.";
}

function apiBase(value: string): string {
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error("insecure");
    }
    return url.href.replace(/\/$/, "");
  } catch {
    throw new PluginApiError(
      "insecure_api_url",
      "The service connection is not configured correctly.",
      "Try again or contact support if the problem continues.",
    );
  }
}

async function callApi<T>(
  apiUrl: string,
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
  transport: ApiTransport,
): Promise<T> {
  const response = await transport(`${apiBase(apiUrl)}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (response.status >= 200 && response.status < 300) {
    return response.json as T;
  }
  const body = response.json as {
    error?: { code?: string; message?: string };
  } | null;
  const code = body?.error?.code ?? "api_request_failed";
  throw new PluginApiError(
    code,
    body?.error?.message ?? "The cloud service request failed.",
    recoveryFor(response.status, code),
  );
}

export async function loadIdentityAndTargets(
  apiUrl: string,
  token: string,
  transport: ApiTransport,
) {
  const owner = await callApi<{ owner: { id: string; anonymous: boolean } }>(
    apiUrl,
    token,
    "/v1/whoami",
    {},
    transport,
  );
  const targets = await callApi<Project[]>(
    apiUrl,
    token,
    "/v1/targets",
    {},
    transport,
  );
  return { owner: owner.owner, targets };
}

export async function verifyPluginIdentity(
  input: {
    apiUrl: string;
    tokenCandidate: string;
    storedToken: string;
    projectId: string;
    bindingId: string;
  },
  persistToken: (token: string) => void,
  transport: ApiTransport,
) {
  const token = input.tokenCandidate || input.storedToken;
  if (!token) {
    throw new PluginApiError(
      "token_required",
      "Enter an Identity Token first.",
      "Create a token on the website, then paste it here.",
    );
  }
  const result = await loadIdentityAndTargets(input.apiUrl, token, transport);
  if (input.tokenCandidate) persistToken(input.tokenCandidate);
  const targets = result.targets.filter(({ status }) => status === "active");
  const projectAvailable = targets.some(({ id }) => id === input.projectId);
  return {
    ...result,
    targets,
    projectId: projectAvailable ? input.projectId : "",
    bindingId: projectAvailable ? input.bindingId : "",
  };
}

export async function activatePluginVault(
  input: {
    apiUrl: string;
    token: string;
    activationId: string;
    projectId: string;
    deviceId: string;
    vaultName: string;
  },
  transport: ApiTransport,
) {
  return callApi<{
    project: Project;
    binding: {
      id: string;
      projectId: string;
      deviceId: string;
      vaultName: string;
    };
  }>(
    input.apiUrl,
    input.token,
    "/v1/vault-activations",
    {
      method: "POST",
      body: {
        ...(input.projectId ? { projectId: input.projectId } : {}),
        activationId: input.activationId,
        deviceId: input.deviceId,
        vaultName: input.vaultName,
      },
    },
    transport,
  );
}

export async function loadSyncEvents(
  input: {
    apiUrl: string;
    token: string;
    projectId: string;
    bindingId: string;
  },
  transport: ApiTransport,
) {
  return callApi<SyncEvent[]>(
    input.apiUrl,
    input.token,
    `/v1/projects/${encodeURIComponent(input.projectId)}/sync-events?bindingId=${encodeURIComponent(input.bindingId)}`,
    {},
    transport,
  );
}

export async function loadCaptureStatuses(
  input: {
    apiUrl: string;
    token: string;
    projectId: string;
    bindingId: string;
  },
  transport: ApiTransport,
) {
  return callApi<CaptureStatusRecord[]>(
    input.apiUrl,
    input.token,
    `/v1/projects/${encodeURIComponent(input.projectId)}/capture-statuses?bindingId=${encodeURIComponent(input.bindingId)}`,
    {},
    transport,
  );
}

export async function acknowledgeSyncEvent(
  input: {
    apiUrl: string;
    token: string;
    eventId: string;
    bindingId: string;
  },
  transport: ApiTransport,
) {
  return callApi<{ id: string; acknowledgedAt: string }>(
    input.apiUrl,
    input.token,
    `/v1/sync-events/${encodeURIComponent(input.eventId)}/ack`,
    { method: "POST", body: { bindingId: input.bindingId } },
    transport,
  );
}
