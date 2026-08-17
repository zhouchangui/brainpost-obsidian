import { TFile, TFolder, type FileManager, type Vault } from "obsidian";
import { PluginApiError, renderCaptureStatus, type SyncEvent } from "./client";

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
    .replace(/[\u0000-\u001f\u007f]/g, " ")
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

export async function writeSyncEvent(
  vault: Vault,
  fileManager: FileManager,
  event: SyncEvent,
  projectId: string,
  managedHash = "",
  managedPath = "",
): Promise<{
  result: "created" | "existing" | "updated";
  contentHash: string;
  path: string;
  statusNotePreserved: boolean;
}> {
  if (
    !uuid.test(event.id) ||
    !uuid.test(event.captureId) ||
    event.projectId !== projectId ||
    event.payloadVersion !== 1 ||
    typeof event.markdown !== "string" ||
    event.markdown.length === 0
  ) {
    throw new PluginApiError(
      "invalid_sync_event",
      "The cloud returned an invalid Sync Event.",
      "No file was changed. Retry later or check the configured API.",
    );
  }
  const prepared =
    event.processingMode === "cloud"
      ? prepareCloudMarkdown(event.markdown)
      : {
          markdown: event.markdown,
          title: titleFromMetadata(
            event.markdown.replaceAll("\r\n", "\n").split("\n"),
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
