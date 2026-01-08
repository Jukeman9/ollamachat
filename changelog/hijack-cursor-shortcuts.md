# Plan: Cmd+L Hijack Settings Toggle (Clean Reimplementation)

## Goal
Add a "Hijack Cmd+L shortcut" toggle in the settings menu that modifies the user's keybindings.json.

## Files to Modify
1. `src/extension.ts` - Add keybindings helper functions and commands
2. `src/sidebarProvider.ts` - Add settings panel UI and message handlers
3. `package.json` - Ensure `ollamaChat.sendSelection` keybinding is registered

## Implementation Pattern
Follow the EXACT same pattern as the existing `history-panel` implementation.

---

## Step 1: extension.ts - Add Keybindings Helpers

Add at the top (after imports):
```typescript
import * as path from 'path';
import * as fs from 'fs';

// Keybindings Hijack Helpers
function getKeybindingsPath(): string {
  const platform = process.platform;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (platform === 'darwin') {
    return path.join(home, 'Library/Application Support/Cursor/User/keybindings.json');
  } else if (platform === 'win32') {
    return path.join(process.env.APPDATA || '', 'Cursor/User/keybindings.json');
  } else {
    return path.join(home, '.config/Cursor/User/keybindings.json');
  }
}

function stripJsonComments(content: string): string {
  return content.replace(/^\s*\/\/.*$/gm, '');
}

function readKeybindings(): any[] {
  const filePath = getKeybindingsPath();
  if (!fs.existsSync(filePath)) return [];
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const stripped = stripJsonComments(content);
    const trimmed = stripped.trim();
    if (!trimmed) return [];
    return JSON.parse(trimmed);
  } catch { return []; }
}

function writeKeybindings(keybindings: any[]): void {
  const filePath = getKeybindingsPath();
  const header = '// Place your key bindings in this file to override the defaults\n';
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, header + JSON.stringify(keybindings, null, 4), 'utf8');
}

const HIJACK_ENTRY = {
  key: process.platform === 'darwin' ? 'cmd+l' : 'ctrl+l',
  command: '-aichat.newchataction',
  when: 'view.ollamaChat.chatView.visible && editorTextFocus && editorHasSelection'
};

export function isHijackEnabled(): boolean {
  return readKeybindings().some(kb => kb.command === '-aichat.newchataction' && kb.when?.includes('ollamaChat'));
}

function enableHijack(): boolean {
  try {
    const keybindings = readKeybindings();
    if (!isHijackEnabled()) {
      keybindings.push(HIJACK_ENTRY);
      writeKeybindings(keybindings);
    }
    return true;
  } catch { return false; }
}

function disableHijack(): boolean {
  try {
    let keybindings = readKeybindings();
    keybindings = keybindings.filter(kb => !(kb.command === '-aichat.newchataction' && kb.when?.includes('ollamaChat')));
    writeKeybindings(keybindings);
    return true;
  } catch { return false; }
}
```

In `activate()`, register commands:
```typescript
// Hijack shortcut commands
context.subscriptions.push(
  vscode.commands.registerCommand('ollamaChat.enableHijack', () => {
    if (enableHijack()) {
      vscode.window.showInformationMessage('Cmd+L hijack enabled. Reload to apply.', 'Reload')
        .then(sel => { if (sel === 'Reload') vscode.commands.executeCommand('workbench.action.reloadWindow'); });
    }
  }),
  vscode.commands.registerCommand('ollamaChat.disableHijack', () => {
    if (disableHijack()) {
      vscode.window.showInformationMessage('Cmd+L hijack disabled. Reload to apply.', 'Reload')
        .then(sel => { if (sel === 'Reload') vscode.commands.executeCommand('workbench.action.reloadWindow'); });
    }
  })
);
```

---

## Step 2: sidebarProvider.ts - Add Settings Panel

### 2a. Add import at top:
```typescript
import { isHijackEnabled } from './extension';
```

### 2b. Add message handlers (in `resolveWebviewView`, after `stopGeneration` case):
```typescript
case 'enableHijack':
  vscode.commands.executeCommand('ollamaChat.enableHijack');
  break;
case 'disableHijack':
  vscode.commands.executeCommand('ollamaChat.disableHijack');
  break;
case 'getHijackState':
  this.postMessage({ type: 'hijackState', enabled: isHijackEnabled() });
  break;
```

### 2c. Add CSS (after `.history-panel.open` styles, around line 615):
```css
/* Settings Panel */
.settings-panel {
  position: absolute;
  top: 0;
  right: 0;
  width: 280px;
  height: 100%;
  background: var(--vscode-sideBar-background);
  border-left: 1px solid var(--vscode-panel-border);
  z-index: 50;
  display: none;
  flex-direction: column;
}

.settings-panel.open {
  display: flex;
}

.settings-header {
  padding: 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.settings-header h3 {
  font-size: 14px;
  font-weight: 600;
}

.settings-content {
  padding: 12px;
}

.settings-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  cursor: pointer;
  border-radius: 4px;
  font-size: 12px;
}

.settings-item:hover {
  background: var(--vscode-list-hoverBackground);
}

.settings-item input[type="checkbox"] {
  width: 14px;
  height: 14px;
  cursor: pointer;
}

.settings-hint {
  padding: 8px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}
```

### 2d. Add HTML (after `</div>` closing history-panel, before `<script>`):
```html
<div class="settings-panel" id="settingsPanel">
  <div class="settings-header">
    <h3>Settings</h3>
    <button class="icon-button" id="closeSettingsBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
  </div>
  <div class="settings-content">
    <label class="settings-item">
      <input type="checkbox" id="hijackShortcut">
      <span>Hijack Cmd+L shortcut</span>
    </label>
    <div class="settings-hint">When enabled, Cmd+L sends selected code to Ollama Chat instead of Cursor AI. Requires window reload.</div>
  </div>
</div>
```

### 2e. Add JS DOM elements (after `historySearch` declaration):
```javascript
const settingsPanel = document.getElementById('settingsPanel');
const hijackShortcut = document.getElementById('hijackShortcut');
```

### 2f. Add JS message handler (in switch, after `insertText` case):
```javascript
case 'hijackState':
  hijackShortcut.checked = msg.enabled;
  break;
```

### 2g. Update settingsBtn onclick (replace the alert):
```javascript
document.getElementById('settingsBtn').onclick = () => {
  settingsPanel.classList.toggle('open');
  historyPanel.classList.remove('open');
  if (settingsPanel.classList.contains('open')) {
    vscode.postMessage({ type: 'getHijackState' });
  }
};
```

### 2h. Add closeSettingsBtn onclick (after closeHistoryBtn):
```javascript
document.getElementById('closeSettingsBtn').onclick = () => {
  settingsPanel.classList.remove('open');
};
```

### 2i. Add hijackShortcut change listener (after closeSettingsBtn):
```javascript
hijackShortcut.addEventListener('change', (e) => {
  if (e.target.checked) {
    vscode.postMessage({ type: 'enableHijack' });
  } else {
    vscode.postMessage({ type: 'disableHijack' });
  }
});
```

### 2j. Close settings panel on document click (update existing handler):
```javascript
document.addEventListener('click', () => {
  modelDropdown.classList.remove('open');
});
```
NOTE: Don't add settingsPanel here - it has a close button like history panel.

---

## Key Differences from Failed Implementation

1. **Use `settings-panel` class** (like `history-panel`), NOT `settings-menu`
2. **Full-height panel** sliding from right (like history), NOT a dropdown
3. **Has close button** in header, NOT relies on clicking outside
4. **Same CSS pattern**: `position: absolute; top: 0; right: 0; width: 280px; height: 100%`
5. **Same JS pattern**: `classList.toggle('open')` with explicit close button handler

---

---

## Step 3: package.json - Register Keybinding

**CRITICAL**: The extension must register the `ollamaChat.sendSelection` keybinding in package.json. Without this, the hijack toggle does nothing because there's no Ollama Chat keybinding to take over.

Ensure `keybindings` array includes:
```json
"keybindings": [
  {
    "command": "ollamaChat.chatView.focus",
    "key": "ctrl+shift+o",
    "mac": "cmd+shift+o",
    "when": "!terminalFocus"
  },
  {
    "command": "ollamaChat.sendSelection",
    "key": "ctrl+l",
    "mac": "cmd+l",
    "when": "view.ollamaChat.chatView.visible && editorTextFocus && editorHasSelection"
  }
]
```

**How it all works together:**
1. `package.json` registers `ollamaChat.sendSelection` with Cmd+L (but Cursor's `aichat.newchataction` has priority)
2. When user enables "Hijack Cmd+L shortcut", we add `-aichat.newchataction` to user's keybindings.json
3. This disables Cursor's binding when our conditions are met
4. Now `ollamaChat.sendSelection` takes over

---

## Testing
1. `npm run build-vsix && cursor --install-extension ollama-chat-0.1.0.vsix --force`
2. Reload Cursor
3. Click 3-dot menu → Settings panel should slide in from right
4. Check "Hijack Cmd+L shortcut" → should see info message with Reload button
5. Click Reload
6. Select text in editor, ensure Ollama Chat sidebar is visible
7. Press Cmd+L → should send to Ollama Chat (not Cursor AI)
