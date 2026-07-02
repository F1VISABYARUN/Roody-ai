---
name: build-zip
description: Package the Roody extension into a shareable zip that loads cleanly via chrome://extensions "Load unpacked" after extraction.
---

# Build the Roody Distribution Zip

From the repo root:

```bash
rm -f Roody-ai.zip
zip -r Roody-ai.zip . -x ".git/*" "node_modules/*" ".claude/*" ".agents/*" "*.zip"
```

The zip must contain `manifest.json` at its root (not nested in a folder) plus `src/` and `README.md`.

## Install instructions to give the user

1. Unzip the file
2. Chrome → `chrome://extensions`
3. Toggle **Developer mode** (top right)
4. **Load unpacked** → select the unzipped folder
5. If updating an existing install: click the ↻ refresh icon on the Roody card, then refresh any open AI-site tabs (content scripts don't reload automatically)

## Chrome Web Store packaging

For a store upload, the same zip works but check first:
- `manifest.json` version was bumped (Chrome rejects same-version uploads)
- No API keys anywhere in the source
- No `console.log` of sensitive data
