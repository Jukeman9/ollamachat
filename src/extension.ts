import * as vscode from 'vscode';
import { OllamaService } from './ollamaService';
import { OllamaClient } from './ollamaClient';
import { ChatManager } from './chatManager';
import { ContextTracker } from './contextTracker';
import { OllamaChatProvider } from './sidebarProvider';

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

  console.log('Ollama Chat extension activated');
}

export function deactivate(): void {
  console.log('Ollama Chat extension deactivated');
}
