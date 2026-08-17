# BrainPost for Obsidian

BrainPost automatically syncs finished notes from [brainpost.me](https://brainpost.me) into the `Inbox/` folder of your local Obsidian vault.

## Requirements

- Obsidian desktop 1.11.4 or newer. The plugin does not support mobile devices.
- A BrainPost account and Identity Token. An account and network connection are required for the plugin's full functionality.

## How it works

After you verify an Identity Token and connect the vault, sync runs automatically when Obsidian opens, regains focus, and every 30 seconds while it remains open. **Check now** is a fallback for an immediate check or retry; routine syncing does not require button clicks.

BrainPost downloads processing status and finished Markdown from the connected BrainPost project. It creates or updates only the notes it manages and acknowledges successfully written sync events to prevent duplicate delivery.

## Install

### Community plugins

After the plugin is accepted into the Obsidian community directory, search for **BrainPost** under **Settings → Community plugins → Browse**, install it, and enable it.

### Manual installation

1. Download `main.js` and `manifest.json` from the latest [GitHub Release](https://github.com/zhouchangui/brainpost-obsidian/releases/latest).
2. Put both files in `<vault>/.obsidian/plugins/brainpost/`.
3. Reload Obsidian and enable **BrainPost** under **Settings → Community plugins**.

## Connect and sync

1. Get an Identity Token from [BrainPost](https://brainpost.me/#account).
2. Open **Settings → Community plugins → BrainPost**.
3. Paste the token and choose **Verify & connect**.
4. Leave Obsidian open; new finished notes arrive automatically. Use **Check now** only when you want an immediate check or need to retry.

## Data and network use

The plugin connects only to `https://brainpost.me/api` to authenticate, connect the current vault, retrieve capture status and finished notes, and acknowledge successful sync events.

Requests may include the Identity Token, a plugin-generated device ID, the vault name, and BrainPost project, binding, capture, or event identifiers. Responses contain account and project metadata, capture status, and the Markdown that the plugin writes locally. The plugin does not upload existing vault notes or absolute local vault paths.

The plugin itself does not accept payments or show paid-feature prompts. Any BrainPost service plans are handled separately on brainpost.me.

## Local file changes

BrainPost reads and writes plugin-managed Markdown in `Inbox/`. It may create a short-lived `_pending-…` file before atomically renaming it to the final note. When a finished note replaces an untouched processing-status note, the status note is moved to the system trash through Obsidian. If that status note was edited locally, it is preserved.

The plugin does not access files outside the vault. Identity Token, device ID, and binding secrets are stored through Obsidian's SecretStorage; project identifiers, managed-content hashes, and managed note paths remain in Obsidian's local plugin data.

## Privacy and security

- The plugin does not include client-side telemetry or analytics.
- The plugin does not display ads.
- The plugin does not install or update itself; Obsidian or the user manages updates.
- The source code is public and is not obfuscated.
- Keep anonymous Identity Tokens safe: they cannot be recovered if lost.

## Troubleshooting

- If automatic sync reports an error, confirm Obsidian is online and choose **Check now** once.
- If verification fails, create or copy a valid Identity Token from BrainPost and try again.
- BrainPost will not overwrite a locally changed managed note. Resolve the reported conflict, then retry.

## Support

Report reproducible bugs or request help in [GitHub Issues](https://github.com/zhouchangui/brainpost-obsidian/issues). Do not include Identity Tokens, private note content, or other credentials in an issue.

## Development

Requires Node.js 22 or newer and pnpm 10.33.1.

```bash
corepack enable
pnpm install
pnpm check
```

## Release

Keep the versions in `package.json`, `manifest.json`, and `versions.json` aligned, then push a tag that exactly matches the version, such as `0.1.1`. GitHub Actions builds and publishes `main.js`, `manifest.json`, and `versions.json`.

## License

[MIT](LICENSE) © 2026 BrainPost contributors.
