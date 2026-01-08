import * as path from 'path';
import * as fs from 'fs';

// ============================================================================
// Keybindings Hijack Helpers
// ============================================================================

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
  // Remove single-line comments
  let result = content.replace(/^\s*\/\/.*$/gm, '');
  // Remove block comments
  result = result.replace(/\/\*[\s\S]*?\*\//g, '');
  return result;
}

function readKeybindings(): any[] {
  const filePath = getKeybindingsPath();
  console.log('[OllamaChat] Reading keybindings from:', filePath);
  if (!fs.existsSync(filePath)) {
    console.log('[OllamaChat] Keybindings file does not exist');
    return [];
  }
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const stripped = stripJsonComments(content);
    const trimmed = stripped.trim();
    if (!trimmed) return [];
    return JSON.parse(trimmed);
  } catch (err) {
    console.error('[OllamaChat] Error reading keybindings:', err);
    return [];
  }
}

function writeKeybindings(keybindings: any[]): void {
  const filePath = getKeybindingsPath();
  const header = '// Place your key bindings in this file to override the defaults\n';
  const dir = path.dirname(filePath);
  console.log('[OllamaChat] Writing keybindings to:', filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, header + JSON.stringify(keybindings, null, 4), 'utf8');
  console.log('[OllamaChat] Keybindings written successfully');
}

// All Cursor commands that use Cmd+L which we need to disable
const CURSOR_CMDL_COMMANDS = [
  'aichat.newchataction',
  'composer.newAgentChat',
  'composer.sendToAgent'
];

function getHijackEntries(): any[] {
  const key = process.platform === 'darwin' ? 'cmd+l' : 'ctrl+l';
  const when = 'ollamaChatVisible && editorTextFocus && editorHasSelection';

  return CURSOR_CMDL_COMMANDS.map(cmd => ({
    key,
    command: `-${cmd}`,
    when
  }));
}

export function isHijackEnabled(): boolean {
  const keybindings = readKeybindings();
  // Check if any of our hijack entries exist
  return keybindings.some(kb =>
    kb.command === '-aichat.newchataction' &&
    kb.when?.includes('ollamaChat')
  );
}

export function enableHijack(): boolean {
  try {
    const keybindings = readKeybindings();
    if (!isHijackEnabled()) {
      const entries = getHijackEntries();
      keybindings.push(...entries);
      writeKeybindings(keybindings);
      console.log('[OllamaChat] Hijack enabled, added entries:', entries);
    }
    return true;
  } catch (err) {
    console.error('[OllamaChat] Error enabling hijack:', err);
    return false;
  }
}

export function disableHijack(): boolean {
  try {
    let keybindings = readKeybindings();
    const before = keybindings.length;
    keybindings = keybindings.filter(kb =>
      !(kb.when?.includes('ollamaChat') && kb.command?.startsWith('-'))
    );
    writeKeybindings(keybindings);
    console.log('[OllamaChat] Hijack disabled, removed', before - keybindings.length, 'entries');
    return true;
  } catch (err) {
    console.error('[OllamaChat] Error disabling hijack:', err);
    return false;
  }
}
