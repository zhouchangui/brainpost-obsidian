import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  requestUrl,
} from "obsidian";
import {
  acknowledgeSyncEvent,
  activatePluginVault,
  type ApiTransport,
  type BinaryApiTransport,
  downloadSyncAsset,
  loadCaptureStatuses,
  loadSyncEvents,
  PluginApiError,
  verifyPluginIdentity,
} from "./client";
import {
  cloudNotePath,
  prepareCloudMarkdown,
  writeCaptureStatus,
  writeSyncEvent,
} from "./sync";

interface BrainPostSettings {
  apiUrl: string;
  activationId: string;
  projectId: string;
  bindingId: string;
  managedNotes: Record<string, string>;
  notePaths: Record<string, string>;
}

const DEFAULT_SETTINGS: BrainPostSettings = {
  apiUrl: "https://brainpost.me/api",
  activationId: "",
  projectId: "",
  bindingId: "",
  managedNotes: {},
  notePaths: {},
};

const TOKEN_SECRET_ID = "knowledge-aggregation-token";
const DEVICE_SECRET_ID = "knowledge-aggregation-device-id";
const BINDING_SECRET_PREFIX = "knowledge-aggregation-binding-";
const bindingSecretId = (projectId: string) =>
  `${BINDING_SECRET_PREFIX}${projectId.replaceAll("-", "")}`;

const obsidianTransport: ApiTransport = async (url, init) => {
  const response = await requestUrl({
    url,
    method: init.method,
    headers: init.headers,
    body: init.body,
    throw: false,
  });
  return { status: response.status, json: response.json };
};

const obsidianBinaryTransport: BinaryApiTransport = async (url, headers) => {
  const response = await requestUrl({
    url,
    method: "GET",
    headers,
    throw: false,
  });
  return {
    status: response.status,
    bytes: response.arrayBuffer,
    json:
      response.status >= 200 && response.status < 300
        ? undefined
        : response.json,
  };
};

export default class BrainPostPlugin extends Plugin {
  settings: BrainPostSettings = { ...DEFAULT_SETTINGS };
  verifiedApiUrl = "";
  status = "Enter an Identity Token to connect this Vault.";
  ready: Promise<void> | null = null;
  private syncInFlight: Promise<void> | null = null;
  private unloading = false;

  onload(): void {
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    this.unloading = false;
    const saved = (await this.loadData()) as Partial<BrainPostSettings> | null;
    const projectId = saved?.projectId ?? "";
    this.settings = {
      apiUrl: DEFAULT_SETTINGS.apiUrl,
      activationId: saved?.activationId ?? "",
      projectId,
      bindingId: this.localBindingId(projectId),
      managedNotes: saved?.managedNotes ?? {},
      notePaths: saved?.notePaths ?? {},
    };
    this.deviceId();
    if (this.settings.bindingId) {
      this.status = "Vault connected. Verify the Token to resume sync.";
    }
    this.addSettingTab(new BrainPostSettingTab(this.app, this));
    this.registerInterval(window.setInterval(() => this.autoSync(), 30_000));
    this.registerDomEvent(window, "focus", () => this.autoSync());
    this.app.workspace.onLayoutReady(() => void this.autoSync());
  }

  async onunload(): Promise<void> {
    this.unloading = true;
    const inFlight = this.syncInFlight;
    if (!inFlight) return;
    // ponytail: cap unload wait at 1s; lifecycle guards stop late Vault writes.
    await Promise.race([
      inFlight.catch(() => undefined),
      new Promise<void>((resolve) => window.setTimeout(resolve, 1000)),
    ]);
  }

  token(): string {
    return this.app.secretStorage.getSecret(TOKEN_SECRET_ID) ?? "";
  }

  deviceId(): string {
    const saved = this.app.secretStorage.getSecret(DEVICE_SECRET_ID);
    if (saved) return saved;
    const created = crypto.randomUUID();
    this.app.secretStorage.setSecret(DEVICE_SECRET_ID, created);
    return created;
  }

  localBindingId(projectId: string): string {
    return projectId
      ? (this.app.secretStorage.getSecret(bindingSecretId(projectId)) ?? "")
      : "";
  }

  saveLocalBinding(projectId: string, bindingId: string): void {
    this.app.secretStorage.setSecret(bindingSecretId(projectId), bindingId);
  }

  async verify(tokenCandidate: string): Promise<void> {
    const previousProjectId = this.settings.projectId;
    this.settings.bindingId = this.localBindingId(previousProjectId);
    const result = await verifyPluginIdentity(
      {
        apiUrl: this.settings.apiUrl,
        tokenCandidate,
        storedToken: this.token(),
        projectId: this.settings.projectId,
        bindingId: this.settings.bindingId,
      },
      (token) => this.app.secretStorage.setSecret(TOKEN_SECRET_ID, token),
      obsidianTransport,
    );
    this.verifiedApiUrl = this.settings.apiUrl;
    if (
      result.projectId !== this.settings.projectId ||
      result.bindingId !== this.settings.bindingId
    ) {
      this.settings.projectId = result.projectId;
      this.settings.bindingId = result.bindingId;
      if (previousProjectId && !result.projectId) {
        this.settings.activationId = crypto.randomUUID();
      }
      await this.saveSettings();
    }
    if (!this.settings.bindingId) {
      await this.activate();
    }
    this.status = result.owner.anonymous
      ? "Vault connected. Keep the anonymous Token safe; it cannot be recovered if lost."
      : "Vault connected. Notes will sync automatically.";
  }

  async activate(): Promise<void> {
    const token = this.token();
    if (!token || this.verifiedApiUrl !== this.settings.apiUrl) {
      throw new PluginApiError(
        "token_verification_required",
        "Verify the Identity Token before connecting this Vault.",
        "Verify the Token, then try again.",
      );
    }
    if (!this.settings.activationId) {
      this.settings.activationId = crypto.randomUUID();
      await this.saveSettings();
    }
    try {
      const activation = await activatePluginVault(
        {
          apiUrl: this.settings.apiUrl,
          token,
          activationId: this.settings.activationId,
          projectId: this.settings.projectId,
          deviceId: this.deviceId(),
          vaultName: this.app.vault.getName(),
        },
        obsidianTransport,
      );
      this.settings.projectId = activation.project.id;
      this.settings.bindingId = activation.binding.id;
      this.saveLocalBinding(activation.project.id, activation.binding.id);
      await this.saveSettings();
      this.status = `Activated “${this.app.vault.getName()}”. Local paths remain on this device.`;
    } catch (error) {
      if (
        error instanceof PluginApiError &&
        [
          "activation_conflict",
          "project_not_found",
          "project_unavailable",
        ].includes(error.code)
      ) {
        this.settings.projectId = "";
        this.settings.bindingId = "";
        this.settings.activationId = crypto.randomUUID();
        await this.saveSettings();
      }
      throw error;
    }
  }

  async sync(): Promise<void> {
    if (this.unloading) return;
    if (this.syncInFlight) return this.syncInFlight;
    const operation = this.performSync();
    this.syncInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.syncInFlight === operation) this.syncInFlight = null;
    }
  }

  private async autoSync(): Promise<void> {
    if (
      this.unloading ||
      !this.token() ||
      !this.settings.projectId ||
      !this.settings.bindingId
    ) {
      return;
    }
    try {
      await this.sync();
    } catch {
      if (!this.unloading) {
        this.status = "Automatic sync failed. Use Check now to retry.";
      }
    }
  }

  private async performSync(): Promise<void> {
    const token = this.token();
    if (!token || !this.settings.projectId || !this.settings.bindingId) {
      throw new PluginApiError(
        "binding_required",
        "Connect this Vault before syncing.",
        "Verify the Token, then try again.",
      );
    }
    const statuses = await loadCaptureStatuses(
      {
        apiUrl: this.settings.apiUrl,
        token,
        projectId: this.settings.projectId,
        bindingId: this.settings.bindingId,
      },
      obsidianTransport,
    );
    if (this.unloading) return;
    let pendingStatuses = 0;
    for (const capture of statuses) {
      if (this.unloading) return;
      if (!["accepted", "processing", "failed"].includes(capture.status)) {
        continue;
      }
      const written = await writeCaptureStatus(
        this.app.vault,
        capture,
        this.settings.managedNotes[capture.id],
      );
      if (this.unloading) return;
      if (written.result === "deleted") continue;
      this.settings.managedNotes[capture.id] = written.contentHash;
      pendingStatuses += 1;
      await this.saveSettings();
      if (this.unloading) return;
    }

    const events = await loadSyncEvents(
      {
        apiUrl: this.settings.apiUrl,
        token,
        projectId: this.settings.projectId,
        bindingId: this.settings.bindingId,
      },
      obsidianTransport,
    );
    if (this.unloading) return;
    let created = 0;
    let updated = 0;
    for (const event of events) {
      if (this.unloading) return;
      const acknowledgement = {
        apiUrl: this.settings.apiUrl,
        token,
        eventId: event.id,
        bindingId: this.settings.bindingId,
      };
      if (event.status === "failed") {
        await acknowledgeSyncEvent(acknowledgement, obsidianTransport);
        continue;
      }
      let notePath = this.settings.notePaths[event.captureId];
      const prepared =
        event.processingMode === "cloud"
          ? prepareCloudMarkdown(event.markdown)
          : { markdown: event.markdown, title: "" };
      if (!notePath && prepared.title) {
        notePath = cloudNotePath(this.app.vault, prepared.title);
        this.settings.notePaths[event.captureId] = notePath;
        await this.saveSettings();
      }
      const written = await writeSyncEvent(
        this.app.vault,
        this.app.fileManager,
        event,
        this.settings.projectId,
        this.settings.managedNotes[event.captureId],
        notePath,
        (asset) =>
          downloadSyncAsset(
            {
              apiUrl: this.settings.apiUrl,
              token,
              eventId: event.id,
              assetId: asset.assetId,
              bindingId: this.settings.bindingId,
            },
            obsidianBinaryTransport,
          ),
      );
      if (this.unloading) return;
      if (written.result === "created") created += 1;
      if (written.result === "updated") updated += 1;
      this.settings.managedNotes[event.captureId] = written.contentHash;
      this.settings.notePaths[event.captureId] = written.path;
      if (written.statusNotePreserved) {
        new Notice(
          `The edited processing note for ${event.captureId} was kept alongside the final note.`,
        );
      }
      await this.saveSettings();
      if (this.unloading) return;
      await acknowledgeSyncEvent(acknowledgement, obsidianTransport);
      if (this.unloading) return;
    }
    this.status =
      events.length || pendingStatuses
        ? `Synced ${events.length} event(s) and ${pendingStatuses} status note(s); created ${created} note(s); updated ${updated} note(s).`
        : "No new notes are ready to sync.";
  }

  async saveSettings(): Promise<void> {
    await this.saveData({
      activationId: this.settings.activationId,
      projectId: this.settings.projectId,
      managedNotes: this.settings.managedNotes,
      notePaths: this.settings.notePaths,
    });
  }
}

class BrainPostSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: BrainPostPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: `Status: ${this.plugin.status}`,
    });

    let tokenCandidate = "";
    const tokenSetting = new Setting(containerEl)
      .setName("Identity token")
      .setDesc(
        "Stored securely in Obsidian. Anonymous tokens cannot be recovered if lost.",
      );
    tokenSetting.descEl.appendText(" ");
    tokenSetting.descEl.createEl("a", {
      text: "Get an Identity token at BrainPost.",
      href: "https://brainpost.me/#account",
    });
    tokenSetting
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder(this.plugin.token() ? "Token saved" : "ikt1_…");
        text.onChange((value) => {
          tokenCandidate = value.trim();
        });
      })
      .addButton((button) =>
        button
          .setButtonText("Verify & connect")
          .setCta()
          .onClick(async () => {
            await this.run(async () => this.plugin.verify(tokenCandidate));
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("Automatic sync")
      .setDesc(
        this.plugin.settings.bindingId
          ? "On — checks when Obsidian opens or regains focus, then every 30 seconds while it stays open. Use Check now only for an immediate check or retry."
          : "Connect this vault to start automatic sync.",
      )
      .addButton((button) =>
        button
          .setButtonText("Check now")
          .setDisabled(!this.plugin.settings.bindingId)
          .onClick(async () => {
            await this.run(() => this.plugin.sync());
            this.display();
          }),
      );
  }

  private async run(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      new Notice(this.plugin.status);
    } catch (error) {
      const message =
        error instanceof PluginApiError
          ? `${error.message} ${error.recovery}`
          : `The plugin could not finish${error instanceof Error ? `: ${error.message}` : ""}. Check your Token and Obsidian storage permissions, then try again.`;
      this.plugin.status = message;
      new Notice(message, 10_000);
    }
  }
}
