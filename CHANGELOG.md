# Changelog

## 0.1.3 - 2026-08-17

### Review fixes

- Use the Obsidian request transport at the plugin boundary instead of a global fetch fallback.
- Keep plugin startup lifecycle methods void-compatible with the Obsidian API.
- Sanitize control characters without a flagged regular expression.

## 0.1.2 - 2026-08-17

### Review fixes

- Remove the redundant product name from the community manifest description.
- Attest the release artifacts and publish only the files consumed by Obsidian.

## 0.1.1 - 2026-08-17

### Fixes

- Wait for the Obsidian workspace before the first automatic sync.
- Move replaced processing-status notes to the system trash instead of deleting them permanently.
- Align the settings interface and production bundle with Obsidian review guidelines.

### Documentation

- Add the MIT license and required account, network, local-file, privacy, payment, and update disclosures.

## 0.1.0 - 2026-08-17

### Features

- Connect an Obsidian vault to BrainPost with an Identity Token.
- Sync finished notes automatically when Obsidian opens, regains focus, and every 30 seconds while open.
- Provide **Check now** as a manual fallback for immediate checks and retries.
- Create and update local notes safely with conflict protection and without uploading local vault paths.
