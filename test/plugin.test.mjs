import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const token = `ikt1_${"F".repeat(43)}`;
const activationId = "25000000-0000-4000-8000-000000000001";
const nodeRequire = createRequire(import.meta.url);

test("plugin exposes the BrainPost public identity", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(
    {
      id: manifest.id,
      name: manifest.name,
      author: manifest.author,
      authorUrl: manifest.authorUrl,
    },
    {
      id: "brainpost",
      name: "BrainPost",
      author: "BrainPost",
      authorUrl: "https://brainpost.me",
    },
  );
});

test("plugin protects one managed note across retries, updates and conflicts", async () => {
  const [{ text: bundle }] = (
    await build({
      entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
      bundle: true,
      external: ["obsidian"],
      format: "cjs",
      platform: "node",
      write: false,
    })
  ).outputFiles;
  const events = [];
  const renderedButtons = [];
  const renderedDescriptionLinks = [];
  const renderedElements = [];
  const renderedSettingNames = [];
  let activationBody;
  let intervalCallback;
  let focusCallback;
  let layoutReadyCallback;
  let verified = false;
  let failRename = true;
  let failAck = false;
  let editBeforeProcess = false;
  let captureStatus = null;
  const image = new Uint8Array([137, 80, 78, 71]);
  const imageSha256 = Buffer.from(
    await webcrypto.subtle.digest("SHA-256", image),
  ).toString("hex");
  let syncEvent = {
    id: "60000000-0000-4000-8000-000000000001",
    projectId: "30000000-0000-4000-8000-000000000001",
    captureId: "50000000-0000-4000-8000-000000000001",
    payloadVersion: 1,
    markdown: "---\ncapture_id: test\n---\n\nA note\n",
    createdAt: "2026-08-06T04:00:00Z",
  };
  class TFile {
    constructor(path, data = "") {
      this.path = path;
      this.data = data;
    }
  }
  class TFolder {
    constructor(path) {
      this.path = path;
    }
  }
  const files = new Map();
  const secrets = new Map([
    ["knowledge-aggregation-token", "stored-token"],
    ["knowledge-aggregation-device-id", "30000000-0000-4000-8000-000000000009"],
  ]);
  const app = {
    secretStorage: {
      getSecret: (id) => secrets.get(id),
      setSecret: (id, value) => {
        assert.match(id, /^[a-z0-9-]{1,64}$/);
        secrets.set(id, value);
        events.push(["persist", id, value]);
      },
    },
    vault: {
      getName: () => "Test Vault",
      getAbstractFileByPath: (path) => files.get(path) ?? null,
      createFolder: async (path) => {
        events.push(["createFolder", path]);
        files.set(path, new TFolder(path));
      },
      create: async (path, data) => {
        events.push(["create", path]);
        const file = new TFile(path, data);
        files.set(path, file);
        return file;
      },
      createBinary: async (path, data) => {
        events.push(["createBinary", path]);
        const file = new TFile(path, data);
        files.set(path, file);
        return file;
      },
      read: async (file) => file.data,
      readBinary: async (file) => file.data,
      process: async (file, change) => {
        events.push(["process", file.path]);
        if (editBeforeProcess) file.data = "last-second user edit";
        file.data = change(file.data);
      },
      rename: async (file, path) => {
        events.push(["rename", file.path, path]);
        if (failRename) throw new Error("disk unavailable");
        files.delete(file.path);
        file.path = path;
        files.set(path, file);
      },
    },
    fileManager: {
      trashFile: async (file) => {
        events.push(["trashFile", file.path]);
        files.delete(file.path);
      },
    },
    workspace: {
      onLayoutReady: (callback) => {
        events.push(["onLayoutReady"]);
        layoutReadyCallback = callback;
      },
    },
  };
  class Plugin {
    constructor(pluginApp) {
      this.app = pluginApp;
    }
    async saveData(value) {
      events.push(["save", JSON.parse(JSON.stringify(value))]);
    }
    async loadData() {
      return {
        apiUrl: "https://custom.example/api",
        activationId,
        bindingId: "40000000-0000-4000-8000-000000000099",
      };
    }
    addSettingTab(tab) {
      this.settingTab = tab;
    }
    registerInterval(id) {
      events.push(["registerInterval", id]);
    }
    registerDomEvent(_target, event, callback) {
      events.push(["registerDomEvent", event]);
      if (event === "focus") focusCallback = callback;
    }
  }
  class PluginSettingTab {
    constructor(settingApp, plugin) {
      this.app = settingApp;
      this.plugin = plugin;
      this.containerEl = {
        empty() {},
        createEl: (tag, options) => renderedElements.push({ tag, ...options }),
      };
    }
  }
  class Setting {
    constructor() {
      this.descEl = {
        appendText() {},
        createEl: (tag, options) =>
          renderedDescriptionLinks.push({
            setting: this.name,
            tag,
            ...options,
          }),
      };
    }
    setName(name) {
      this.name = name;
      renderedSettingNames.push(name);
      return this;
    }
    setDesc(description) {
      this.description = description;
      return this;
    }
    addText(callback) {
      const text = {
        inputEl: {},
        setValue: () => text,
        setPlaceholder: () => text,
        onChange: () => text,
      };
      callback(text);
      return this;
    }
    addDropdown(callback) {
      const dropdown = {
        addOption: () => dropdown,
        setValue: () => dropdown,
        onChange: () => dropdown,
      };
      callback(dropdown);
      return this;
    }
    addToggle(callback) {
      const toggle = {
        setValue: () => toggle,
        onChange: () => toggle,
      };
      callback(toggle);
      return this;
    }
    addButton(callback) {
      const rendered = {
        name: this.name,
        description: this.description,
        disabled: false,
        cta: false,
        text: "",
      };
      const button = {
        setButtonText: (text) => {
          rendered.text = text;
          return button;
        },
        setCta: () => {
          rendered.cta = true;
          return button;
        },
        setDisabled: (disabled) => {
          rendered.disabled = disabled;
          return button;
        },
        onClick: () => button,
      };
      callback(button);
      renderedButtons.push(rendered);
      return this;
    }
  }
  const module = { exports: {} };
  runInNewContext(bundle, {
    module,
    exports: module.exports,
    require: (name) => {
      if (name !== "obsidian") return nodeRequire(name);
      return {
        Notice: class {},
        Plugin,
        PluginSettingTab,
        Setting,
        TFile,
        TFolder,
        requestUrl: async ({ url, method, body }) => {
          const path = new URL(url).pathname.replace(/^\/api(?=\/)/, "");
          events.push(["request", path]);
          if (!verified) {
            return {
              status: 401,
              json: { error: { code: "invalid_token", message: "invalid" } },
            };
          }
          if (path === "/v1/whoami") {
            return {
              status: 200,
              json: { owner: { id: "owner-1", anonymous: false } },
            };
          }
          if (path === "/v1/targets") {
            return { status: 200, json: [] };
          }
          if (path === "/v1/vault-activations") {
            assert.equal(method, "POST");
            activationBody = JSON.parse(body);
            return {
              status: 201,
              json: {
                project: {
                  id: "30000000-0000-4000-8000-000000000001",
                  name: "Test Vault",
                  status: "active",
                },
                binding: {
                  id: "40000000-0000-4000-8000-000000000001",
                  projectId: "30000000-0000-4000-8000-000000000001",
                  deviceId: "30000000-0000-4000-8000-000000000009",
                  vaultName: "Test Vault",
                },
              },
            };
          }
          if (path.endsWith("/capture-statuses")) {
            return { status: 200, json: captureStatus ? [captureStatus] : [] };
          }
          if (path.endsWith("/sync-events")) {
            return {
              status: 200,
              json: syncEvent ? [syncEvent] : [],
            };
          }
          if (path.includes("/assets/")) {
            return {
              status: 200,
              arrayBuffer: image.buffer,
              get json() {
                throw new SyntaxError(
                  `Unexpected token '�', "�PNG" is not valid JSON`,
                );
              },
            };
          }
          if (path.endsWith("/ack")) {
            if (failAck) throw new Error("offline");
            return {
              status: 200,
              json: {
                id: "60000000-0000-4000-8000-000000000001",
                acknowledgedAt: "2026-08-06T04:01:00Z",
              },
            };
          }
          throw new Error(`unexpected request ${path}`);
        },
      };
    },
    crypto: webcrypto,
    TextEncoder,
    URL,
    window: {
      setInterval: (callback, milliseconds) => {
        events.push(["setInterval", milliseconds]);
        intervalCallback = callback;
        return 1;
      },
      setTimeout,
    },
  });
  const PluginClass = module.exports.default;
  const plugin = new PluginClass(app);
  plugin.onload();
  await plugin.ready;
  assert.equal(plugin.settings.apiUrl, "https://brainpost.me/api");
  assert.equal(plugin.settings.bindingId, "");
  assert.deepEqual(events, [
    ["setInterval", 30_000],
    ["registerInterval", 1],
    ["registerDomEvent", "focus"],
    ["onLayoutReady"],
  ]);
  assert.equal(typeof intervalCallback, "function");
  assert.equal(typeof focusCallback, "function");
  assert.equal(typeof layoutReadyCallback, "function");
  events.length = 0;
  await assert.rejects(plugin.verify(token));
  assert.deepEqual(events, [["request", "/v1/whoami"]]);

  verified = true;
  events.length = 0;
  await plugin.verify(token);
  assert.deepEqual(events.slice(0, 3), [
    ["request", "/v1/whoami"],
    ["request", "/v1/targets"],
    ["persist", "knowledge-aggregation-token", token],
  ]);
  assert.equal(
    events.some(
      ([kind, path]) => kind === "request" && path === "/v1/vault-activations",
    ),
    true,
  );

  events.length = 0;
  await plugin.activate();
  assert.deepEqual(activationBody, {
    activationId,
    deviceId: "30000000-0000-4000-8000-000000000009",
    projectId: "30000000-0000-4000-8000-000000000001",
    vaultName: "Test Vault",
  });
  assert.equal(
    events.some(
      ([kind, value]) => kind === "save" && Object.hasOwn(value, "deviceId"),
    ),
    false,
  );
  assert.equal(
    events.some(
      ([kind, value]) => kind === "save" && Object.hasOwn(value, "bindingId"),
    ),
    false,
  );
  assert.equal(
    plugin.settings.projectId,
    "30000000-0000-4000-8000-000000000001",
  );
  assert.equal(
    plugin.settings.bindingId,
    "40000000-0000-4000-8000-000000000001",
  );

  plugin.settingTab.display();
  assert.equal(renderedSettingNames.includes("API URL"), false);
  assert.equal(
    renderedElements.some(({ tag }) => tag === "h1" || tag === "h2"),
    false,
  );
  assert.deepEqual(
    renderedElements.find(({ tag }) => tag === "p"),
    {
      tag: "p",
      cls: "setting-item-description",
      text: `Status: ${plugin.status}`,
    },
  );
  assert.deepEqual(renderedDescriptionLinks, [
    {
      setting: "Identity token",
      tag: "a",
      text: "Get an Identity token at BrainPost.",
      href: "https://brainpost.me/#account",
    },
  ]);
  assert.deepEqual(
    renderedButtons.find(({ name }) => name === "Identity token"),
    {
      name: "Identity token",
      description:
        "Stored securely in Obsidian. Anonymous tokens cannot be recovered if lost.",
      disabled: false,
      cta: true,
      text: "Verify & connect",
    },
  );
  assert.deepEqual(
    renderedButtons.find(({ name }) => name === "Automatic sync"),
    {
      name: "Automatic sync",
      description:
        "On — checks when Obsidian opens or regains focus, then every 30 seconds while it stays open. Use Check now only for an immediate check or retry.",
      disabled: false,
      cta: false,
      text: "Check now",
    },
  );
  assert.equal(
    renderedButtons.some(({ name }) => name === "Activate this Vault"),
    false,
  );

  plugin.settings.apiUrl = "https://other.example";
  events.length = 0;
  await assert.rejects(
    plugin.activate(),
    (error) => error.code === "token_verification_required",
  );
  assert.deepEqual(events, []);

  plugin.settings.apiUrl = "http://127.0.0.1:8787";
  events.length = 0;
  await assert.rejects(plugin.sync(), /disk unavailable/);
  assert.equal(
    events.some(([kind, path]) => kind === "request" && path.endsWith("/ack")),
    false,
  );

  const pending = files.get(
    "Inbox/_pending-60000000-0000-4000-8000-000000000001.md",
  );
  pending.data = "user edit";
  events.length = 0;
  await assert.rejects(
    plugin.sync(),
    (error) => error.code === "pending_note_conflict",
  );
  assert.equal(pending.data, "user edit");
  assert.equal(
    events.some(([kind, path]) => kind === "request" && path.endsWith("/ack")),
    false,
  );

  pending.data = "---\ncapture_id: test\n---\n\nA note\n";
  failRename = false;
  events.length = 0;
  await plugin.sync();
  const renameIndex = events.findIndex(([kind]) => kind === "rename");
  const managedStateIndex = events.findIndex(
    ([kind, value]) =>
      kind === "save" &&
      value.managedNotes["50000000-0000-4000-8000-000000000001"],
  );
  const ackIndex = events.findIndex(
    ([kind, path]) => kind === "request" && path.endsWith("/ack"),
  );
  assert.ok(
    renameIndex >= 0 &&
      managedStateIndex > renameIndex &&
      ackIndex > managedStateIndex,
  );
  assert.equal(
    files.get("Inbox/50000000-0000-4000-8000-000000000001.md").data,
    "---\ncapture_id: test\n---\n\nA note\n",
  );

  syncEvent = {
    ...syncEvent,
    id: "60000000-0000-4000-8000-000000000002",
    markdown: "---\ncapture_id: test\n---\n\nA newer note\n",
  };
  events.length = 0;
  await plugin.sync();
  assert.equal(
    files.get("Inbox/50000000-0000-4000-8000-000000000001.md").data,
    "---\ncapture_id: test\n---\n\nA newer note\n",
  );
  assert.match(plugin.status, /updated 1 note/);

  failAck = true;
  events.length = 0;
  await assert.rejects(plugin.sync(), /offline/);
  failAck = false;
  events.length = 0;
  await plugin.sync();
  assert.equal(
    events.some(([kind]) => ["create", "process", "rename"].includes(kind)),
    false,
  );
  assert.equal(
    events.some(([kind, path]) => kind === "request" && path.endsWith("/ack")),
    true,
  );

  syncEvent = {
    ...syncEvent,
    id: "60000000-0000-4000-8000-000000000005",
    markdown: "---\ncapture_id: test\n---\n\nAn automatic note\n",
  };
  events.length = 0;
  await intervalCallback();
  assert.equal(
    files.get("Inbox/50000000-0000-4000-8000-000000000001.md").data,
    "---\ncapture_id: test\n---\n\nAn automatic note\n",
  );
  assert.equal(
    events.some(([kind, path]) => kind === "request" && path.endsWith("/ack")),
    true,
  );

  syncEvent = {
    ...syncEvent,
    id: "60000000-0000-4000-8000-000000000003",
    markdown: "---\ncapture_id: test\n---\n\nA third note\n",
  };
  editBeforeProcess = true;
  events.length = 0;
  await assert.rejects(
    plugin.sync(),
    (error) => error.code === "note_conflict",
  );
  assert.equal(
    files.get("Inbox/50000000-0000-4000-8000-000000000001.md").data,
    "last-second user edit",
  );
  assert.equal(
    events.some(([kind, path]) => kind === "request" && path.endsWith("/ack")),
    false,
  );
  editBeforeProcess = false;

  const managedNote = files.get(
    "Inbox/50000000-0000-4000-8000-000000000001.md",
  );
  managedNote.data = "user edit";
  syncEvent = {
    ...syncEvent,
    id: "60000000-0000-4000-8000-000000000004",
    markdown: "---\ncapture_id: test\n---\n\nA fourth note\n",
  };
  events.length = 0;
  await assert.rejects(
    plugin.sync(),
    (error) =>
      error.code === "note_conflict" && /not overwritten/i.test(error.recovery),
  );
  assert.equal(managedNote.data, "user edit");
  assert.equal(
    events.some(
      ([kind, path]) =>
        kind === "process" || (kind === "request" && path.endsWith("/ack")),
    ),
    false,
  );

  captureStatus = {
    id: "50000000-0000-4000-8000-000000000010",
    projectId: "30000000-0000-4000-8000-000000000001",
    kind: "url",
    sourceUrl: "https://example.test/pending",
    client: "browser",
    capturedAt: "2026-08-06T04:02:00Z",
    processingMode: "cloud",
    status: "processing",
    failureReason: null,
    updatedAt: "2026-08-06T04:03:00Z",
  };
  syncEvent = null;
  events.length = 0;
  await plugin.sync();
  assert.match(
    files.get("Inbox/50000000-0000-4000-8000-000000000010.md").data,
    /Cloud processing/,
  );
  assert.doesNotMatch(
    files.get("Inbox/50000000-0000-4000-8000-000000000010.md").data,
    /Original content|transcript|summary/i,
  );
  assert.equal(
    events.some(([kind, path]) => kind === "request" && path.endsWith("/ack")),
    false,
  );

  captureStatus = {
    ...captureStatus,
    status: "failed",
    failureReason: "Processing exhausted its retries.",
    updatedAt: "2026-08-06T04:04:00Z",
  };
  syncEvent = {
    id: "60000000-0000-4000-8000-000000000010",
    projectId: captureStatus.projectId,
    captureId: captureStatus.id,
    payloadVersion: 1,
    markdown:
      "# Cloud processing failed\n\n> [!failure] Processing stopped\n> Processing exhausted its retries.\n",
    sourceUrl: captureStatus.sourceUrl,
    inputKind: captureStatus.kind,
    processingMode: "cloud",
    status: "failed",
    createdAt: "2026-08-06T04:04:00Z",
  };
  events.length = 0;
  await plugin.sync();
  const failedStatusPath = "Inbox/50000000-0000-4000-8000-000000000010.md";
  assert.equal(files.has(failedStatusPath), true);
  assert.ok(
    plugin.settings.managedNotes["50000000-0000-4000-8000-000000000010"],
  );
  assert.equal(
    events.some(([kind, path]) => kind === "request" && path.endsWith("/ack")),
    true,
  );
  assert.equal(
    Object.hasOwn(
      plugin.settings.notePaths,
      "50000000-0000-4000-8000-000000000010",
    ),
    false,
    "a failed event must not enter the final-note path",
  );
  captureStatus = null;
  syncEvent = null;
  files.delete(failedStatusPath);
  events.length = 0;
  await plugin.sync();
  assert.equal(
    files.has(failedStatusPath),
    false,
    "a user-deleted failed status note must stay deleted",
  );

  syncEvent = {
    id: "60000000-0000-4000-8000-000000000020",
    projectId: "30000000-0000-4000-8000-000000000001",
    captureId: "50000000-0000-4000-8000-000000000020",
    payloadVersion: 2,
    markdown: "![Diagram](asset://image-001)\n",
    assets: [
      {
        assetId: "90000000-0000-4000-8000-000000000020",
        logicalId: "image-001",
        filename: "diagram.png",
        mediaType: "image/png",
        byteSize: image.byteLength,
        sha256: imageSha256,
      },
    ],
    inputKind: "file",
    processingMode: "standard",
    status: "ready",
    createdAt: "2026-08-21T01:00:00Z",
  };
  events.length = 0;
  await plugin.sync();
  assert.equal(
    files.has(
      "Inbox/attachments/50000000-0000-4000-8000-000000000020/diagram.png",
    ),
    true,
  );
  assert.equal(
    events.some(([kind, path]) => kind === "request" && path.endsWith("/ack")),
    true,
  );

  plugin.syncInFlight = new Promise(() => {});
  const unloadStartedAt = Date.now();
  await plugin.onunload();
  assert.ok(Date.now() - unloadStartedAt < 1_500);
  plugin.syncInFlight = null;
  events.length = 0;
  await plugin.sync();
  assert.deepEqual(events, []);
});
