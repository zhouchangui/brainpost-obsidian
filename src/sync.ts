import { TFile, TFolder, type FileManager, type Vault } from "obsidian";
import {
  PluginApiError,
  renderCaptureStatus,
  type SyncAsset,
  type SyncEvent,
} from "./client";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalidNoteTitles = new Set([
  "capture",
  "captured text",
  "content",
  "organized content",
  "processing metadata",
  "summary",
  "text capture",
]);

function titleFromHeading(value: string): string {
  return value
    .replace(/\s+#+\s*$/, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleFromMetadata(lines: string[]): string {
  const metadataIndex = lines.findIndex((line) =>
    /^###\s+Metadata\s*$/.test(line),
  );
  if (metadataIndex < 0) return "";
  const titleLine = lines
    .slice(metadataIndex + 1)
    .find((line) => /^-\s*标题\s*:\s*.+/.test(line));
  if (!titleLine) return "";
  const title = titleFromHeading(titleLine.replace(/^-\s*标题\s*:\s*/, ""));
  return invalidNoteTitles.has(title.toLocaleLowerCase()) || uuid.test(title)
    ? ""
    : title;
}

export function prepareCloudMarkdown(markdown: string): {
  markdown: string;
  title: string;
} {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const cleaned: string[] = [];
  let inFence = false;
  let title = "";
  let titleLine = -1;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      cleaned.push(line);
      continue;
    }
    if (inFence) {
      cleaned.push(line);
      continue;
    }
    const heading = line.match(/^#\s+(.+?)\s*$/);
    if (heading) {
      const rawCandidate = heading[1];
      if (rawCandidate === undefined) continue;
      const candidate = titleFromHeading(rawCandidate);
      const normalized = candidate.toLocaleLowerCase();
      if (
        !candidate ||
        invalidNoteTitles.has(normalized) ||
        uuid.test(candidate)
      ) {
        continue;
      }
      if (!title) {
        title = candidate;
        titleLine = cleaned.length;
        cleaned.push(`# ${candidate}`);
      } else if (candidate.toLocaleLowerCase() !== title.toLocaleLowerCase()) {
        throw new PluginApiError(
          "invalid_sync_event",
          "The cloud returned more than one final note title.",
          "No file was changed. Retry after the cloud result is corrected.",
        );
      }
      continue;
    }
    if (
      /^##+\s+(?:organized content|processing metadata|text capture)\s*$/i.test(
        line,
      )
    ) {
      continue;
    }
    cleaned.push(line);
  }
  if (!title) {
    const metadataTitle = titleFromMetadata(lines);
    if (metadataTitle) title = metadataTitle;
  }
  if (!title || !cleaned.slice(titleLine + 1).some((line) => line.trim())) {
    throw new PluginApiError(
      "invalid_sync_event",
      "The cloud returned a final note without a meaningful title.",
      "No file was changed. Retry after the cloud result is corrected.",
    );
  }
  return {
    markdown: cleaned
      .join("\n")
      .replace(/^\n+/, "")
      .replace(/\n{3,}/g, "\n\n"),
    title,
  };
}

function safeNoteName(title: string): string {
  const sanitized = title
    .replace(/\.md$/i, "")
    .replace(/[\\/:*?"<>|]/g, " - ")
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s-]+|[\s-]+$/g, "")
    .slice(0, 120)
    .trim();
  if (!sanitized) {
    throw new PluginApiError(
      "invalid_sync_event",
      "The cloud returned a title that cannot be used as a filename.",
      "No file was changed. Retry after the cloud result is corrected.",
    );
  }
  return sanitized;
}

function availableNotePath(
  vault: Vault,
  folderPath: string,
  title: string,
): string {
  const baseName = safeNoteName(title);
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const name = suffix === 1 ? baseName : `${baseName} (${suffix})`;
    const path = `${folderPath}/${name}.md`;
    if (!vault.getAbstractFileByPath(path)) return path;
  }
  throw new PluginApiError(
    "note_conflict",
    `Too many notes share the title ${baseName}.`,
    "Rename one of the existing notes, then retry.",
  );
}

export function cloudNotePath(vault: Vault, title: string): string {
  return availableNotePath(vault, "Inbox", title);
}

async function removeManagedStatusNote(
  vault: Vault,
  fileManager: FileManager,
  captureId: string,
  managedHash: string,
  finalPath: string,
): Promise<boolean> {
  const statusPath = `Inbox/${captureId}.md`;
  if (!managedHash || statusPath === finalPath) {
    return false;
  }
  const status = vault.getAbstractFileByPath(statusPath);
  if (!(status instanceof TFile)) return false;
  const expected = await vault.read(status);
  if ((await hashMarkdown(expected)) !== managedHash) return true;
  let unchanged = false;
  await vault.process(status, (latest) => {
    unchanged = latest === expected;
    return latest;
  });
  if (unchanged) {
    await fileManager.trashFile(status);
    return false;
  }
  return true;
}

export async function hashMarkdown(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function hashBytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function ensureFolder(vault: Vault, path: string): Promise<void> {
  const existing = vault.getAbstractFileByPath(path);
  if (!existing) await vault.createFolder(path);
  else if (!(existing instanceof TFolder)) {
    throw new PluginApiError(
      "attachment_path_conflict",
      `A file blocks the attachment folder ${path}.`,
      "No note was changed. Move the conflicting file, then retry sync.",
    );
  }
}

function validSyncAsset(asset: SyncAsset): boolean {
  return (
    uuid.test(asset.assetId) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(asset.logicalId) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(asset.filename) &&
    asset.mediaType.startsWith("image/") &&
    Number.isSafeInteger(asset.byteSize) &&
    asset.byteSize > 0 &&
    /^[0-9a-f]{64}$/.test(asset.sha256)
  );
}

async function deliverAssets(
  vault: Vault,
  event: SyncEvent,
  loadAsset: (asset: SyncAsset) => Promise<Uint8Array>,
): Promise<string> {
  const assets = event.assets ?? [];
  if (
    assets.some((asset) => !validSyncAsset(asset)) ||
    new Set(assets.map((asset) => asset.logicalId)).size !== assets.length ||
    new Set(assets.map((asset) => asset.filename)).size !== assets.length
  ) {
    throw new PluginApiError(
      "invalid_sync_event",
      "The cloud returned an invalid Document Asset manifest.",
      "No note was changed. Retry after the cloud result is corrected.",
    );
  }
  const downloads: Array<{ asset: SyncAsset; bytes: Uint8Array }> = [];
  for (const asset of assets) {
    const bytes = await loadAsset(asset);
    if (
      bytes.byteLength !== asset.byteSize ||
      (await hashBytes(bytes)) !== asset.sha256
    ) {
      throw new PluginApiError(
        "asset_checksum_mismatch",
        `The downloaded Document Asset ${asset.logicalId} failed verification.`,
        "No note was changed. Retry the download.",
      );
    }
    downloads.push({ asset, bytes });
  }

  await ensureFolder(vault, "Inbox");
  await ensureFolder(vault, "Inbox/attachments");
  const folder = `Inbox/attachments/${event.captureId}`;
  await ensureFolder(vault, folder);
  const plans: Array<{
    asset: SyncAsset;
    bytes: Uint8Array;
    path: string;
    temporaryPath: string;
    temporaryFile?: TFile;
    complete: boolean;
  }> = [];
  for (const { asset, bytes } of downloads) {
    const path = `${folder}/${asset.filename}`;
    const temporaryPath = `${folder}/_pending-${event.id}-${asset.filename}`;
    const existing = vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      if (
        (await hashBytes(new Uint8Array(await vault.readBinary(existing)))) !==
        asset.sha256
      ) {
        throw new PluginApiError(
          "attachment_conflict",
          `The existing attachment ${path} has different content.`,
          "No file was overwritten. Move the conflicting attachment, then retry sync.",
        );
      }
      plans.push({ asset, bytes, path, temporaryPath, complete: true });
    } else if (existing) {
      throw new PluginApiError(
        "attachment_conflict",
        `A folder blocks the attachment ${path}.`,
        "No file was overwritten. Move the conflicting folder, then retry sync.",
      );
    } else {
      const temporary = vault.getAbstractFileByPath(temporaryPath);
      if (temporary instanceof TFile) {
        if (
          (await hashBytes(
            new Uint8Array(await vault.readBinary(temporary)),
          )) !== asset.sha256
        ) {
          throw new PluginApiError(
            "attachment_conflict",
            `The pending attachment ${temporaryPath} has different content.`,
            "No file was overwritten. Move the conflicting attachment, then retry sync.",
          );
        }
        plans.push({
          asset,
          bytes,
          path,
          temporaryPath,
          temporaryFile: temporary,
          complete: false,
        });
      } else if (temporary) {
        throw new PluginApiError(
          "attachment_conflict",
          `A folder blocks the pending attachment ${temporaryPath}.`,
          "Move the conflicting folder, then retry sync.",
        );
      } else {
        plans.push({ asset, bytes, path, temporaryPath, complete: false });
      }
    }
  }

  for (const plan of plans.filter(({ complete }) => !complete)) {
    plan.temporaryFile ??= await vault.createBinary(
      plan.temporaryPath,
      new Uint8Array(plan.bytes).buffer,
    );
    if (
      (await hashBytes(
        new Uint8Array(await vault.readBinary(plan.temporaryFile)),
      )) !== plan.asset.sha256
    ) {
      throw new PluginApiError(
        "asset_checksum_mismatch",
        `The local Document Asset ${plan.asset.logicalId} failed verification.`,
        "No note was changed. Retry sync.",
      );
    }
  }
  for (const plan of plans.filter(({ complete }) => !complete)) {
    await vault.rename(plan.temporaryFile!, plan.path);
  }

  let markdown = event.markdown;
  for (const { asset } of downloads) {
    markdown = markdown.replaceAll(
      `asset://${asset.logicalId}`,
      `attachments/${event.captureId}/${asset.filename}`,
    );
  }
  if (/asset:\/\//.test(markdown)) {
    throw new PluginApiError(
      "invalid_sync_event",
      "The Markdown references a Document Asset missing from its manifest.",
      "No note was changed. Retry after the cloud result is corrected.",
    );
  }
  return markdown;
}

export async function writeSyncEvent(
  vault: Vault,
  fileManager: FileManager,
  event: SyncEvent,
  projectId: string,
  managedHash = "",
  managedPath = "",
  loadAsset?: (asset: SyncAsset) => Promise<Uint8Array>,
): Promise<{
  result: "created" | "existing" | "updated";
  contentHash: string;
  path: string;
  statusNotePreserved: boolean;
}> {
  if (
    event.payloadVersion === 2 &&
    (event.assets?.length ?? 0) > 0 &&
    !loadAsset
  ) {
    throw new PluginApiError(
      "sync_assets_not_supported",
      "This Sync Event contains private document assets that this plugin cannot deliver yet.",
      "No file was changed. Update the BrainPost plugin, then retry sync.",
    );
  }
  if (
    !uuid.test(event.id) ||
    !uuid.test(event.captureId) ||
    event.projectId !== projectId ||
    ![1, 2].includes(event.payloadVersion) ||
    typeof event.markdown !== "string" ||
    event.markdown.length === 0
  ) {
    throw new PluginApiError(
      "invalid_sync_event",
      "The cloud returned an invalid Sync Event.",
      "No file was changed. Retry later or check the configured API.",
    );
  }
  const markdown =
    event.payloadVersion === 2 && (event.assets?.length ?? 0) > 0
      ? await deliverAssets(vault, event, loadAsset!)
      : event.markdown;
  const prepared =
    event.processingMode === "cloud"
      ? prepareCloudMarkdown(markdown)
      : {
          markdown,
          title: titleFromMetadata(
            markdown.replaceAll("\r\n", "\n").split("\n"),
          ),
        };
  const contentHash = await hashMarkdown(prepared.markdown);

  const folderPath = "Inbox";
  const folder = vault.getAbstractFileByPath(folderPath);
  if (!folder) await vault.createFolder(folderPath);
  else if (!(folder instanceof TFolder)) {
    throw new PluginApiError(
      "inbox_path_conflict",
      "A file named Inbox blocks note sync.",
      "Rename that file, then retry sync.",
    );
  }

  const finalPath = managedPath
    ? managedPath
    : prepared.title
      ? availableNotePath(vault, folderPath, prepared.title)
      : `${folderPath}/${event.captureId}.md`;
  const finalFile = vault.getAbstractFileByPath(finalPath);
  if (finalFile) {
    if (finalFile instanceof TFile) {
      const current = await vault.read(finalFile);
      if (current === prepared.markdown) {
        const statusNotePreserved = await removeManagedStatusNote(
          vault,
          fileManager,
          event.captureId,
          managedHash,
          finalPath,
        );
        return {
          result: "existing",
          contentHash,
          path: finalPath,
          statusNotePreserved,
        };
      }
      if (managedHash && (await hashMarkdown(current)) === managedHash) {
        await vault.process(finalFile, (latest) => {
          if (latest !== current) {
            throw new PluginApiError(
              "note_conflict",
              `The existing note ${finalPath} changed during sync.`,
              "The note was not overwritten or acknowledged. Retry to inspect the latest local version.",
            );
          }
          return prepared.markdown;
        });
        const statusNotePreserved = await removeManagedStatusNote(
          vault,
          fileManager,
          event.captureId,
          managedHash,
          finalPath,
        );
        return {
          result: "updated",
          contentHash,
          path: finalPath,
          statusNotePreserved,
        };
      }
    }
    throw new PluginApiError(
      "note_conflict",
      `The existing note ${finalPath} differs from the cloud event.`,
      "The note was not overwritten or acknowledged. Move or rename it, then retry.",
    );
  }

  const temporaryPath = `${folderPath}/_pending-${event.id}.md`;
  const temporary = vault.getAbstractFileByPath(temporaryPath);
  let temporaryFile: TFile;
  if (!temporary)
    temporaryFile = await vault.create(temporaryPath, prepared.markdown);
  else if (temporary instanceof TFile) {
    temporaryFile = temporary;
    if ((await vault.read(temporaryFile)) !== prepared.markdown) {
      throw new PluginApiError(
        "pending_note_conflict",
        `The pending note ${temporaryPath} differs from the cloud event.`,
        "The note was not overwritten or acknowledged. Move or rename it, then retry.",
      );
    }
  } else {
    throw new PluginApiError(
      "temporary_path_conflict",
      "A folder blocks the temporary sync file.",
      "Remove the conflicting folder, then retry sync.",
    );
  }
  if ((await vault.read(temporaryFile)) !== prepared.markdown) {
    throw new PluginApiError(
      "pending_note_conflict",
      `The pending note ${temporaryPath} changed during sync.`,
      "The note was not overwritten or acknowledged. Retry to inspect the latest local version.",
    );
  }
  await vault.rename(temporaryFile, finalPath);
  const statusNotePreserved = await removeManagedStatusNote(
    vault,
    fileManager,
    event.captureId,
    managedHash,
    finalPath,
  );
  return {
    result: "created",
    contentHash,
    path: finalPath,
    statusNotePreserved,
  };
}

export async function writeCaptureStatus(
  vault: Vault,
  status: import("./client").CaptureStatusRecord,
  managedHash = "",
): Promise<{
  result: "created" | "existing" | "updated" | "deleted";
  contentHash: string;
}> {
  if (
    !uuid.test(status.id) ||
    status.processingMode !== "cloud" ||
    !["accepted", "processing", "failed"].includes(status.status)
  ) {
    throw new PluginApiError(
      "invalid_capture_status",
      "The cloud returned an invalid Capture status.",
      "No file was changed. Retry later or check the configured API.",
    );
  }
  const markdown = renderCaptureStatus(status);
  const contentHash = await hashMarkdown(markdown);
  const folderPath = "Inbox";
  const folder = vault.getAbstractFileByPath(folderPath);
  if (!folder) await vault.createFolder(folderPath);
  else if (!(folder instanceof TFolder)) {
    throw new PluginApiError(
      "inbox_path_conflict",
      "A file named Inbox blocks note sync.",
      "Rename that file, then retry sync.",
    );
  }

  const finalPath = `${folderPath}/${status.id}.md`;
  const finalFile = vault.getAbstractFileByPath(finalPath);
  if (!finalFile && managedHash) return { result: "deleted", contentHash };
  if (finalFile) {
    if (finalFile instanceof TFile) {
      const current = await vault.read(finalFile);
      if (current === markdown) return { result: "existing", contentHash };
      if (managedHash && (await hashMarkdown(current)) === managedHash) {
        await vault.process(finalFile, (latest) => {
          if (latest !== current) {
            throw new PluginApiError(
              "note_conflict",
              `The existing note ${finalPath} changed during status sync.`,
              "The note was not overwritten. Retry to inspect the latest local version.",
            );
          }
          return markdown;
        });
        return { result: "updated", contentHash };
      }
    }
    throw new PluginApiError(
      "note_conflict",
      `The existing note ${finalPath} differs from the cloud status.`,
      "The note was not overwritten. Move or rename it, then retry.",
    );
  }

  const temporaryPath = `${folderPath}/_pending-status-${status.id}.md`;
  const temporary = vault.getAbstractFileByPath(temporaryPath);
  let temporaryFile: TFile;
  if (!temporary) temporaryFile = await vault.create(temporaryPath, markdown);
  else if (temporary instanceof TFile) {
    temporaryFile = temporary;
    if ((await vault.read(temporaryFile)) !== markdown) {
      throw new PluginApiError(
        "pending_note_conflict",
        `The pending status note ${temporaryPath} differs from the cloud status.`,
        "The note was not overwritten. Retry to inspect the latest local version.",
      );
    }
  } else {
    throw new PluginApiError(
      "temporary_path_conflict",
      "A folder blocks the temporary status file.",
      "Remove the conflicting folder, then retry sync.",
    );
  }
  await vault.rename(temporaryFile, finalPath);
  return { result: "created", contentHash };
}
