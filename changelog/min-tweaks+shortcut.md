# Green Accent Color Unification + Keyboard Shortcut

## Goal
1. Create a single CSS variable for the green accent color (like Cursor uses)
2. Apply it to: active mode button, context indicator fill, "Current" badge
3. Add Cmd+Shift+O keyboard shortcut to focus the extension

## Changes

### File 1: `src/sidebarProvider.ts`

**Add CSS variable at top of styles (after `body` styles):**
```css
:root {
  --accent-green: #4ade80;  /* Cursor's green accent */
}
```

**Update `.dropdown-button` to support active state:**
```css
.dropdown-button.active {
  color: var(--accent-green);
}
```

**Update `.context-fill` - change from blue to green:**
```css
.context-fill {
  background: conic-gradient(
    var(--accent-green) calc(var(--context-percent) * 1%),  /* was --vscode-textLink-foreground */
    transparent calc(var(--context-percent) * 1%)
  );
}
```

**Update `.badge` - use green for "Current" badge:**
```css
.badge {
  background: var(--accent-green);
  color: #000;  /* Dark text on green background */
}
```

**Add `active` class to mode button HTML:**
```html
<button class="dropdown-button active" id="modeBtn">...
```

### File 2: `package.json`

**Add keybindings section to contributes:**
```json
"keybindings": [
  {
    "command": "ollamaChat.chatView.focus",
    "key": "ctrl+shift+o",
    "mac": "cmd+shift+o",
    "when": "!terminalFocus"
  }
]
```

- `key`: Default for Windows/Linux (Ctrl+Shift+O)
- `mac`: Override for macOS (Cmd+Shift+O)

## Summary of locations using `--accent-green`
1. `.dropdown-button.active` - mode button text color
2. `.context-fill` - circular context indicator fill
3. `.badge` - "Current" label background in chat history
