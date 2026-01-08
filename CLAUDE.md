After changes always run:
```bash
npm run build-vsix && cursor --install-extension ollama-chat-0.1.0.vsix --force
```

Note: `npm run compile` only builds to dist/. To install changes, you MUST rebuild the VSIX package with `npm run build-vsix` (which runs compile automatically via prepublish script).
