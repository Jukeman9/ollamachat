# Cmd+L Hijack When Sidebar Open

## Goal
When Ollama Chat sidebar is **visible**, Cmd+L (Mac) / Ctrl+L (Windows/Linux) sends selected text to our extension.
When sidebar is **closed**, default Cursor behavior works normally.

---

## Attempt 1: Package.json Keybinding with `when` Clause

### Approach
Add a keybinding in `package.json` with a specific `when` clause that should take priority:

```json
{
  "command": "ollamaChat.sendSelection",
  "key": "ctrl+l",
  "mac": "cmd+l",
  "when": "view.ollamaChat.chatView.visible && editorTextFocus && editorHasSelection"
}
```

### Result: FAILED
Cursor's `aichat.newchataction` has Cmd+L bound with **no `when` clause**, making it a catch-all that fires first. VS Code/Cursor keybinding priority doesn't prefer "more specific when clauses" over bindings without conditions.

---

## Attempt 2: Negative Keybinding in Package.json

### Approach
Add a negative keybinding (`-command`) in `package.json` to disable Cursor's binding:

```json
{
  "key": "ctrl+l",
  "mac": "cmd+l",
  "command": "-aichat.newchataction",
  "when": "view.ollamaChat.chatView.visible && editorTextFocus && editorHasSelection"
}
```

### Result: FAILED
**Negative keybindings only work in user's `keybindings.json`, NOT in extension `package.json`.**
Extensions can only define positive keybindings; users override them in their personal keybindings configuration.

---

## Solution: Programmatic User Keybindings Modification

### Discovery
The user's keybindings.json can be modified programmatically by the extension (with user consent via a settings toggle).

### Keybindings.json Location

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Cursor/User/keybindings.json` |
| Linux | `~/.config/Cursor/User/keybindings.json` |
| Windows | `%APPDATA%\Cursor\User\keybindings.json` |

### Keybindings.json Format

**Important characteristics:**
1. **JSONC format** - Contains comments (e.g., `// Place your key bindings...`)
2. **Standard JSON.parse() will FAIL** - Must strip comments before parsing
3. **Array of keybinding objects** - Each with `key`, `command`, and optional `when`

**Example file structure:**
```jsonc
// Place your key bindings in this file to override the defaults
[
    {
        "key": "shift+cmd+l",
        "command": "-composer.newAgentChat"
    },
    {
        "key": "cmd+l",
        "command": "-aichat.newchataction",
        "when": "view.ollamaChat.chatView.visible && editorTextFocus && editorHasSelection"
    }
]
```

**Key format conventions:**
- Lowercase: `cmd+l` not `Cmd+L`
- Mac modifier: `cmd` (not `meta` or `super`)
- Windows/Linux modifier: `ctrl`
- Separator: `+`

**Cursor AI commands that use Cmd+L:**
- `aichat.newchataction` - Main chat (no `when` clause - catch-all)
- `composer.newAgentChat` - Agent chat
- `composer.sendToAgent` - Send to agent (has `when` clause)

### Implementation

#### UX Design
Settings toggle in the webview menu (3 dots in top-right corner):
- Checkbox: **"Hijack Cmd+L shortcut"**
- Checked → adds negative keybinding to user's keybindings.json
- Unchecked → removes the entry from keybindings.json
- No confirmation dialog - user controls it directly

#### Entry to Add/Remove
```json
{
  "key": "cmd+l",
  "command": "-aichat.newchataction",
  "when": "view.ollamaChat.chatView.visible && editorTextFocus && editorHasSelection"
}
```

#### Files to Modify
1. `src/extension.ts` - Add keybindings helper functions and commands
2. `src/ChatViewProvider.ts` - Handle hijack toggle messages
3. Webview HTML/JS - Add checkbox to menu UI
4. `package.json` - Remove non-working negative keybinding, optionally register commands

#### Helper Functions Required

```typescript
// Get cross-platform keybindings path
function getKeybindingsPath(): string

// Strip // comments from JSONC
function stripJsonComments(content: string): string

// Read keybindings array from file
function readKeybindings(): any[]

// Write keybindings array to file (preserves header comment)
function writeKeybindings(keybindings: any[]): void

// Check if our hijack entry exists
function isHijackEnabled(): boolean

// Add hijack entry (if not exists)
function enableHijack(): void

// Remove hijack entry
function disableHijack(): void
```

#### Message Flow
1. Webview checkbox change → `postMessage({ type: 'enableHijack' })` or `disableHijack`
2. ChatViewProvider receives message → executes command
3. Command modifies keybindings.json
4. User reloads window to apply

---

## Notes
- `ollamaChat.sendSelection` command already exists in extension.ts
- User must reload Cursor window after toggling for changes to take effect
- Works on all platforms (macOS, Windows, Linux)
