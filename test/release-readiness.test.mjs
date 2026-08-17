import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const text = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("community release includes the required public disclosures", async () => {
  const [readme, license] = await Promise.all([text("README.md"), text("LICENSE")]);

  for (const heading of [
    "Requirements",
    "How it works",
    "Data and network use",
    "Local file changes",
    "Privacy and security",
    "Support",
    "License",
  ]) {
    assert.match(readme, new RegExp(`## ${heading}`));
  }
  for (const disclosure of [
    /BrainPost account/i,
    /https:\/\/brainpost\.me\/api/,
    /Identity Token/i,
    /device ID/i,
    /vault name/i,
    /Inbox\//,
    /does not access files outside/i,
    /does not include client-side telemetry/i,
    /does not display ads/i,
    /does not install or update itself/i,
  ]) {
    assert.match(readme, disclosure);
  }
  assert.match(license, /^MIT License/m);
  assert.match(license, /Copyright \(c\) 2026 BrainPost contributors/);
});

test("release metadata stays aligned and produces a minified bundle", async () => {
  const [manifest, pkg, versions, workflow] = await Promise.all([
    ...["manifest.json", "package.json", "versions.json"].map(async (path) =>
      JSON.parse(await text(path)),
    ),
    text(".github/workflows/release.yml"),
  ]);

  assert.equal(pkg.version, manifest.version);
  assert.equal(versions[manifest.version], manifest.minAppVersion);
  assert.doesNotMatch(manifest.description, /\bObsidian\b/);
  assert.match(pkg.scripts.build, /(?:^|\s)--minify(?:\s|$)/);
  assert.match(workflow, /actions\/attest@v4/);
  assert.match(workflow, /subject-path:\s*\|[\s\S]*main\.js[\s\S]*manifest\.json/);
  assert.match(workflow, /gh release create[\s\S]*main\.js manifest\.json/);
  assert.doesNotMatch(workflow, /gh release create[\s\S]*versions\.json/);
});
