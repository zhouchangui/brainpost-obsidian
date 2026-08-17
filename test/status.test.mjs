import assert from "node:assert/strict";
import test from "node:test";
import { renderCaptureStatus } from "../src/client.ts";

test("capture status Markdown shows provenance and phase but no content", () => {
  const markdown = renderCaptureStatus({
    id: "50000000-0000-4000-8000-000000000001",
    projectId: "20000000-0000-4000-8000-000000000001",
    kind: "url",
    sourceUrl: "https://example.com/article",
    client: "browser-extension",
    capturedAt: "2026-08-06T03:00:00.000Z",
    processingMode: "cloud",
    status: "processing",
    failureReason: null,
    updatedAt: "2026-08-06T03:01:00.000Z",
  });

  assert.match(markdown, /processing_state: "processing"/);
  assert.match(markdown, /https:\/\/example\.com\/article/);
  assert.match(markdown, /Cloud processing/);
  assert.doesNotMatch(markdown, /Original content|summary|transcript/i);
});

test("failed capture status reports service exhaustion without suggesting Queue retry", () => {
  const markdown = renderCaptureStatus({
    id: "50000000-0000-4000-8000-000000000001",
    projectId: "20000000-0000-4000-8000-000000000001",
    kind: "text",
    sourceUrl: null,
    client: "cli",
    capturedAt: "2026-08-06T03:00:00.000Z",
    processingMode: "cloud",
    status: "failed",
    failureReason: "temporary_model_error",
    updatedAt: "2026-08-06T03:01:00.000Z",
  });

  assert.match(markdown, /processing_state: "failed"/);
  assert.match(markdown, /temporary_model_error/);
  assert.match(markdown, /Processing stopped/);
  assert.match(markdown, /Share the content again/);
  assert.doesNotMatch(markdown, /Sync now|Queue/i);
});
