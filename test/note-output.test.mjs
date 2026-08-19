import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const projectId = "30000000-0000-4000-8000-000000000001";
const captureId = "50000000-0000-4000-8000-000000000001";
const eventId = "60000000-0000-4000-8000-000000000001";

async function loadSyncModule() {
  const [{ text: bundle }] = (
    await build({
      entryPoints: [fileURLToPath(new URL("../src/sync.ts", import.meta.url))],
      bundle: true,
      external: ["obsidian", "node:*"],
      format: "cjs",
      platform: "node",
      write: false,
    })
  ).outputFiles;
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
  const trashed = [];
  const vault = {
    getAbstractFileByPath: (path) => files.get(path) ?? null,
    getMarkdownFiles: () =>
      [...files.values()].filter((file) => file instanceof TFile),
    createFolder: async (path) => files.set(path, new TFolder(path)),
    create: async (path, data) => {
      const file = new TFile(path, data);
      files.set(path, file);
      return file;
    },
    createBinary: async (path, data) => {
      const file = new TFile(path, data);
      files.set(path, file);
      return file;
    },
    read: async (file) => file.data,
    readBinary: async (file) => file.data,
    process: async (file, change) => {
      file.data = change(file.data);
    },
    rename: async (file, path) => {
      files.delete(file.path);
      file.path = path;
      files.set(path, file);
    },
  };
  const fileManager = {
    trashFile: async (file) => {
      trashed.push(file.path);
      files.delete(file.path);
    },
  };
  const module = { exports: {} };
  runInNewContext(bundle, {
    module,
    exports: module.exports,
    require: (name) =>
      name === "obsidian"
        ? { TFile, TFolder }
        : createRequire(import.meta.url)(name),
    crypto: globalThis.crypto,
    TextEncoder,
    AbortController,
    process,
  });
  return { module: module.exports, fileManager, files, trashed, vault };
}

function event(markdown, overrides = {}) {
  return {
    id: eventId,
    projectId,
    captureId,
    payloadVersion: 1,
    markdown,
    processingMode: "cloud",
    createdAt: "2026-08-07T04:00:00Z",
    ...overrides,
  };
}

test("payload v2 with private assets is rejected before any Vault write", async () => {
  const { module, fileManager, files, vault } = await loadSyncModule();
  await assert.rejects(
    module.writeSyncEvent(
      vault,
      fileManager,
      event("# Document", {
        payloadVersion: 2,
        assets: [
          {
            assetId: "90000000-0000-4000-8000-000000000001",
            logicalId: "image-001",
            filename: "image-001.png",
            mediaType: "image/png",
            byteSize: 68,
            sha256: "a".repeat(64),
          },
        ],
      }),
      projectId,
    ),
    (error) => error.code === "sync_assets_not_supported",
  );
  assert.equal(files.size, 0);
});

test("payload v2 without assets writes deterministic Markdown normally", async () => {
  const { module, fileManager, files, vault } = await loadSyncModule();
  const markdown =
    "## 内容总结\n\nCSV converted.\n\n## 原始文本内容\n\n| name | value |\n| --- | --- |\n| BrainPost | 1 |\n\n---\n\n### Metadata\n\n- 标题: archive";
  const result = await module.writeSyncEvent(
    vault,
    fileManager,
    event(markdown, { payloadVersion: 2, assets: [] }),
    projectId,
  );
  assert.equal(result.path, "Inbox/archive.md");
  assert.equal(files.get(result.path).data, markdown);
});

test("payload v2 writes verified attachments before the visible Markdown note", async () => {
  const { module, fileManager, files, vault } = await loadSyncModule();
  const image = new TextEncoder().encode("png-bytes");
  const sha256 = createHash("sha256").update(image).digest("hex");
  const markdown =
    "## 内容总结\n\nConverted.\n\n## 原始文本内容\n\nBefore.\n\n![Diagram](asset://image-001)\n\nAfter.\n\n---\n\n### Metadata\n\n- 标题: illustrated-report";
  const result = await module.writeSyncEvent(
    vault,
    fileManager,
    event(markdown, {
      payloadVersion: 2,
      processingMode: "standard",
      assets: [
        {
          assetId: "90000000-0000-4000-8000-000000000001",
          logicalId: "image-001",
          filename: "image-001.png",
          mediaType: "image/png",
          byteSize: image.byteLength,
          sha256,
        },
      ],
    }),
    projectId,
    "",
    "",
    async () => image,
  );
  const attachmentPath = `Inbox/attachments/${captureId}/image-001.png`;
  assert.equal(result.path, "Inbox/illustrated-report.md");
  assert.deepEqual(new Uint8Array(files.get(attachmentPath).data), image);
  assert.match(
    files.get(result.path).data,
    new RegExp(`attachments/${captureId}/image-001\\.png`),
  );
  assert.equal(files.get(result.path).data.includes("asset://"), false);
});

test("payload v2 checksum failure leaves no visible note or attachment", async () => {
  const { module, fileManager, files, vault } = await loadSyncModule();
  const first = new TextEncoder().encode("valid-first-image");
  const second = new TextEncoder().encode("wrong-second-image");
  await assert.rejects(
    module.writeSyncEvent(
      vault,
      fileManager,
      event(
        "![One](asset://image-001)\n![Two](asset://image-002)\n\n### Metadata\n\n- 标题: broken",
        {
          payloadVersion: 2,
          processingMode: "standard",
          assets: [
            {
              assetId: "90000000-0000-4000-8000-000000000001",
              logicalId: "image-001",
              filename: "image-001.png",
              mediaType: "image/png",
              byteSize: first.byteLength,
              sha256: createHash("sha256").update(first).digest("hex"),
            },
            {
              assetId: "90000000-0000-4000-8000-000000000002",
              logicalId: "image-002",
              filename: "image-002.png",
              mediaType: "image/png",
              byteSize: second.byteLength,
              sha256: "a".repeat(64),
            },
          ],
        },
      ),
      projectId,
      "",
      "",
      async (asset) => (asset.logicalId === "image-001" ? first : second),
    ),
    (error) => error.code === "asset_checksum_mismatch",
  );
  assert.equal(
    [...files.keys()].some((path) => path.endsWith(".md")),
    false,
  );
  assert.equal(
    [...files.keys()].some((path) => path.endsWith(".png")),
    false,
  );
});

test("payload v2 retry reuses matching attachments and rejects conflicting bytes", async () => {
  const { module, fileManager, files, vault } = await loadSyncModule();
  const image = new TextEncoder().encode("stable-png");
  const sha256 = createHash("sha256").update(image).digest("hex");
  const syncEvent = event(
    "![Diagram](asset://image-001)\n\n### Metadata\n\n- 标题: retry-safe",
    {
      payloadVersion: 2,
      processingMode: "standard",
      assets: [
        {
          assetId: "90000000-0000-4000-8000-000000000001",
          logicalId: "image-001",
          filename: "image-001.png",
          mediaType: "image/png",
          byteSize: image.byteLength,
          sha256,
        },
      ],
    },
  );
  const first = await module.writeSyncEvent(
    vault,
    fileManager,
    syncEvent,
    projectId,
    "",
    "",
    async () => image,
  );
  const second = await module.writeSyncEvent(
    vault,
    fileManager,
    syncEvent,
    projectId,
    "",
    first.path,
    async () => image,
  );
  assert.equal(second.result, "existing");

  const attachmentPath = `Inbox/attachments/${captureId}/image-001.png`;
  files.get(attachmentPath).data = new TextEncoder().encode(
    "other-data",
  ).buffer;
  await assert.rejects(
    module.writeSyncEvent(
      vault,
      fileManager,
      syncEvent,
      projectId,
      "",
      first.path,
      async () => image,
    ),
    (error) => error.code === "attachment_conflict",
  );
  assert.equal(files.get(first.path).data.includes("asset://"), false);
});

test("cloud final output uses its title and removes the untouched status note", async () => {
  const { module, fileManager, files, trashed, vault } = await loadSyncModule();
  const status = await module.writeCaptureStatus(vault, {
    id: captureId,
    projectId,
    kind: "text",
    sourceUrl: null,
    client: "test",
    capturedAt: "2026-08-07T04:00:00Z",
    processingMode: "cloud",
    status: "processing",
    failureReason: null,
    updatedAt: "2026-08-07T04:01:00Z",
  });
  const markdown =
    "# Text Capture\n\n## Organized content\n\n# 习近平与张又侠关系分析\n\n## 摘要\n\n一段简明摘要。\n\n## 关键要点\n\n- 第一条事实。\n\n## 完整整理内容\n\n完整的结构化正文。\n\n# 习近平与张又侠关系分析\n\n## Processing metadata\n\n- Capture ID: test";
  const expectedMarkdown =
    "# 习近平与张又侠关系分析\n\n## 摘要\n\n一段简明摘要。\n\n## 关键要点\n\n- 第一条事实。\n\n## 完整整理内容\n\n完整的结构化正文。\n\n- Capture ID: test";

  const result = await module.writeSyncEvent(
    vault,
    fileManager,
    event(markdown),
    projectId,
    status.contentHash,
  );

  assert.equal(result.path, "Inbox/习近平与张又侠关系分析.md");
  assert.deepEqual(trashed, [`Inbox/${captureId}.md`]);
  assert.equal(files.has(`Inbox/${captureId}.md`), false);
  assert.equal(files.get(result.path).data, expectedMarkdown);
});

test("content-first cloud output reads title from Metadata without adding an H1", async () => {
  const { module, fileManager, files, vault } = await loadSyncModule();
  const markdown =
    "## 内容总结\n\n摘要。\n\n## 原始文本内容\n\n原文。\n\n---\n\n### Metadata\n\n- 标题: 元数据标题\n- 来源: example.test\n- 类型: webpage\n- 状态: success\n";
  const result = await module.writeSyncEvent(
    vault,
    fileManager,
    event(markdown),
    projectId,
  );
  assert.equal(result.path, "Inbox/元数据标题.md");
  assert.equal(files.get(result.path).data, markdown);
});

test("standard final output uses its Metadata title as the filename", async () => {
  const { module, fileManager, files, vault } = await loadSyncModule();
  const markdown =
    "## 内容总结\n\n摘要。\n\n## 原始文本内容\n\n原文。\n\n---\n\n### Metadata\n\n- 标题: 标准网页标题\n- 来源: example.test\n- 类型: webpage\n- 状态: success\n";
  const result = await module.writeSyncEvent(
    vault,
    fileManager,
    event(markdown, { processingMode: "standard" }),
    projectId,
  );
  assert.equal(result.path, "Inbox/标准网页标题.md");
  assert.equal(files.get(result.path).data, markdown);
});

test("edited processing notes are kept and surfaced", async () => {
  const { module, fileManager, files, vault } = await loadSyncModule();
  const status = await module.writeCaptureStatus(vault, {
    id: captureId,
    projectId,
    kind: "text",
    sourceUrl: null,
    client: "test",
    capturedAt: "2026-08-07T04:00:00Z",
    processingMode: "cloud",
    status: "processing",
    failureReason: null,
    updatedAt: "2026-08-07T04:01:00Z",
  });
  files.get(`Inbox/${captureId}.md`).data += "\nUser notes.";

  const result = await module.writeSyncEvent(
    vault,
    fileManager,
    event("# Kept status note\n\n## 摘要\n\nA complete result."),
    projectId,
    status.contentHash,
  );

  assert.equal(result.statusNotePreserved, true);
  assert.equal(files.has(`Inbox/${captureId}.md`), true);
});

test("new cloud filenames are sanitized, disambiguated and retry-stable", async () => {
  const { module, fileManager, files, vault } = await loadSyncModule();
  await vault.create("Inbox/Research - Notes - Q.md", "existing note");
  const markdown =
    "# Research: Notes / Q?\n\n## 摘要\n\nSummary.\n\n## 完整整理内容\n\nDetails.";

  const first = await module.writeSyncEvent(
    vault,
    fileManager,
    event(markdown),
    projectId,
  );
  const retry = await module.writeSyncEvent(
    vault,
    fileManager,
    event(markdown),
    projectId,
    first.contentHash,
    first.path,
  );

  assert.equal(first.path, "Inbox/Research - Notes - Q (2).md");
  assert.equal(retry.path, first.path);
  assert.equal(files.get(first.path).data, markdown);
});

test("different captures with identical titles and content get separate notes", async () => {
  const { module, fileManager, files, vault } = await loadSyncModule();
  const markdown = "# Same title\n\n## 摘要\n\nSame content.";
  const first = await module.writeSyncEvent(
    vault,
    fileManager,
    event(markdown),
    projectId,
  );
  const second = await module.writeSyncEvent(
    vault,
    fileManager,
    event(markdown, {
      id: "60000000-0000-4000-8000-000000000002",
      captureId: "50000000-0000-4000-8000-000000000002",
    }),
    projectId,
  );

  assert.equal(first.path, "Inbox/Same title.md");
  assert.equal(second.path, "Inbox/Same title (2).md");
  assert.equal(files.get(second.path).data, markdown);
});

test("cloud output without a meaningful title is rejected before writing", async () => {
  const { module, fileManager, files, vault } = await loadSyncModule();
  await assert.rejects(
    module.writeSyncEvent(
      vault,
      fileManager,
      event(
        "# Text Capture\n\n## Organized content\n\nA result without a real title.",
      ),
      projectId,
    ),
    (error) => error.code === "invalid_sync_event",
  );
  assert.equal(files.size, 0);
});

test("content-first cloud output with an invalid metadata title is rejected", async () => {
  const { module, fileManager, files, vault } = await loadSyncModule();
  await assert.rejects(
    module.writeSyncEvent(
      vault,
      fileManager,
      event(
        "## 内容总结\n\n摘要\n\n## 原始文本内容\n\n原文\n\n---\n\n### Metadata\n\n- 标题: Text Capture\n- 来源: test\n",
      ),
      projectId,
    ),
    (error) => error.code === "invalid_sync_event",
  );
  assert.equal(files.size, 0);
});
