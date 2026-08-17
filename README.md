# BrainPost for Obsidian

BrainPost automatically syncs finished notes from [brainpost.me](https://brainpost.me) into your local Obsidian vault.

## Install

Until the plugin is listed in the Obsidian community directory:

1. Download `main.js` and `manifest.json` from the latest GitHub Release.
2. Put both files in `<vault>/.obsidian/plugins/brainpost/`.
3. Enable **BrainPost** in Obsidian's community plugin settings.
4. Paste your Identity Token and choose **Verify & connect**. Sync then runs automatically; **Check now** is only a manual fallback.

## Develop

Requires Node.js 22 or newer and pnpm 10.33.1.

```bash
corepack enable
pnpm install
pnpm check
```

## Release

Keep the versions in `package.json`, `manifest.json`, and `versions.json` aligned, then push a tag that exactly matches the version, such as `0.1.0`. GitHub Actions builds and publishes the Obsidian release assets.
