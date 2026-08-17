import assert from "node:assert/strict";
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
    read: async (file) => file.data,
    process: async (file, change) => {
      file.data = change(file.data);
    },
    rename: async (file, path) => {
      files.delete(file.path);
      file.path = path;
      files.set(path, file);
    },
    delete: async (file) => files.delete(file.path),
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
  return { module: module.exports, files, vault };
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

test("cloud final output uses its title and removes the untouched status note", async () => {
  const { module, files, vault } = await loadSyncModule();
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
    event(markdown),
    projectId,
    status.contentHash,
  );

  assert.equal(result.path, "Inbox/习近平与张又侠关系分析.md");
  assert.equal(files.has(`Inbox/${captureId}.md`), false);
  assert.equal(files.get(result.path).data, expectedMarkdown);
});

test("content-first cloud output reads title from Metadata without adding an H1", async () => {
  const { module, files, vault } = await loadSyncModule();
  const markdown =
    "## 内容总结\n\n摘要。\n\n## 原始文本内容\n\n原文。\n\n---\n\n### Metadata\n\n- 标题: 元数据标题\n- 来源: example.test\n- 类型: webpage\n- 状态: success\n";
  const result = await module.writeSyncEvent(vault, event(markdown), projectId);
  assert.equal(result.path, "Inbox/元数据标题.md");
  assert.equal(files.get(result.path).data, markdown);
});

test("standard final output uses its Metadata title as the filename", async () => {
  const { module, files, vault } = await loadSyncModule();
  const markdown =
    "## 内容总结\n\n摘要。\n\n## 原始文本内容\n\n原文。\n\n---\n\n### Metadata\n\n- 标题: 标准网页标题\n- 来源: example.test\n- 类型: webpage\n- 状态: success\n";
  const result = await module.writeSyncEvent(
    vault,
    event(markdown, { processingMode: "standard" }),
    projectId,
  );
  assert.equal(result.path, "Inbox/标准网页标题.md");
  assert.equal(files.get(result.path).data, markdown);
});

test("edited processing notes are kept and surfaced", async () => {
  const { module, files, vault } = await loadSyncModule();
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
    event("# Kept status note\n\n## 摘要\n\nA complete result."),
    projectId,
    status.contentHash,
  );

  assert.equal(result.statusNotePreserved, true);
  assert.equal(files.has(`Inbox/${captureId}.md`), true);
});

test("new cloud filenames are sanitized, disambiguated and retry-stable", async () => {
  const { module, files, vault } = await loadSyncModule();
  await vault.create("Inbox/Research - Notes - Q.md", "existing note");
  const markdown =
    "# Research: Notes / Q?\n\n## 摘要\n\nSummary.\n\n## 完整整理内容\n\nDetails.";

  const first = await module.writeSyncEvent(vault, event(markdown), projectId);
  const retry = await module.writeSyncEvent(
    vault,
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
  const { module, files, vault } = await loadSyncModule();
  const markdown = "# Same title\n\n## 摘要\n\nSame content.";
  const first = await module.writeSyncEvent(vault, event(markdown), projectId);
  const second = await module.writeSyncEvent(
    vault,
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
  const { module, files, vault } = await loadSyncModule();
  await assert.rejects(
    module.writeSyncEvent(
      vault,
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
  const { module, files, vault } = await loadSyncModule();
  await assert.rejects(
    module.writeSyncEvent(
      vault,
      event(
        "## 内容总结\n\n摘要\n\n## 原始文本内容\n\n原文\n\n---\n\n### Metadata\n\n- 标题: Text Capture\n- 来源: test\n",
      ),
      projectId,
    ),
    (error) => error.code === "invalid_sync_event",
  );
  assert.equal(files.size, 0);
});
