import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { OllamaService } from './ollamaService';
import { OllamaClient } from './ollamaClient';
import { ChatManager } from './chatManager';
import { ContextTracker } from './contextTracker';
import { OllamaChatProvider } from './sidebarProvider';

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

let chatProvider: OllamaChatProvider;

export function activate(context: vscode.ExtensionContext): void {
  const ollamaService = new OllamaService();
  const ollamaClient = new OllamaClient();
  const chatManager = new ChatManager(context);
  const contextTracker = new ContextTracker();

  chatProvider = new OllamaChatProvider(
    context,
    ollamaService,
    ollamaClient,
    chatManager,
    contextTracker
  );

  // Register the webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'ollamaChat.chatView',
      chatProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );

  // Register new chat command
  context.subscriptions.push(
    vscode.commands.registerCommand('ollamaChat.newChat', () => {
      chatProvider.newChat();
    })
  );

  // Register send selection command
  context.subscriptions.push(
    vscode.commands.registerCommand('ollamaChat.sendSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No active text editor');
        return;
      }

      const selection = editor.document.getText(editor.selection);
      if (selection) {
        const fileName = editor.document.fileName.split('/').pop() || 'file';
        const language = editor.document.languageId;
        const formattedText = `\`\`\`${language}\n// ${fileName}\n${selection}\n\`\`\``;
        chatProvider.sendToChat(formattedText);

        // Focus the sidebar
        vscode.commands.executeCommand('ollamaChat.chatView.focus');
      } else {
        vscode.window.showWarningMessage('No text selected');
      }
    })
  );

  // Register hijack shortcut commands
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

  console.log('Ollama Chat extension activated');
}

export function deactivate(): void {
  console.log('Ollama Chat extension deactivated');
}
