# Ollama Chat VS Code Extension - Implementation Plan

## Overview
VS Code extension for offline chat with local Ollama models. UI clones Cursor IDE's chat interface using **VS Code theme variables** (adapts to any theme).

## Key Features
1. **Auto-start Ollama** - Detect if running, start if not, show progress notification
2. **Cursor-style sidebar** - Exact clone of Cursor's chat UI
3. **Chat management** - Create, rename, delete chats; history with search
4. **Model selection** - Show all installed models with load status indicator
5. **Context window tracking** - Show % used (e.g., "4.2% · 8.5K / 204.8K")
6. **Thinking display** - Show "Thought for Xs" with expandable reasoning
7. **Streaming responses** - Word-by-word display
8. **Persistence** - Save conversations to workspace

## Ollama API Capabilities

| Feature | Support | API |
|---------|---------|-----|
| Start server | Yes | Spawn `ollama serve` process |
| Detect running | Yes | HTTP GET `localhost:11434` |
| Model load state | Yes | `GET /api/ps` returns loaded models |
| Context window size | Yes | `/api/ps` → `context_length` field |
| Context usage | Yes | Response → `prompt_eval_count + eval_count` |
| Thinking/reasoning | Yes | `think: true` param → `message.thinking` field |

---

## UI Design (Cursor Clone)

### Header Bar
```
┌─────────────────────────────────────────┐
│ Initial conversation greeting  [+] [⏱] [...] │
├─────────────────────────────────────────┤
│ Now · Grok Code                              │
└─────────────────────────────────────────┘
```
- **Chat title** (left) - editable, auto-generated from first message
- **+ button** - New conversation
- **⏱ clock button** - Open chat history panel
- **... dots** - Settings menu (show "No settings yet" for now)
- **Subheader**: timestamp + model name

### Chat History Panel (when clock clicked)
```
┌─────────────────────────────────────────┐
│ Search...                               │
├─────────────────────────────────────────┤
│ Today                                   │
│ 💬 Initial conversation greeting [Current] [✏️] [🗑] │
│ 💬 New Chat                        20m  │
└─────────────────────────────────────────┘
```
- Search field at top
- Grouped by date (Today, Yesterday, etc.)
- Each chat: icon, title, "Current" badge if active, edit/delete buttons
- Time since creation on right

### Messages Area
```
┌─────────────────────────────────────────┐
│ ┌─────────────────────────────────────┐ │
│ │ hi there                            │ │  ← User: bubble
│ └─────────────────────────────────────┘ │
│                                         │
│ Thought for 1s                          │  ← Clickable, expands thinking
│                                         │
│ Hello! I'm here to help you...          │  ← Assistant: no bubble
│                                    [...] │
└─────────────────────────────────────────┘
```
- **User messages**: Rounded bubble, full width
- **Assistant messages**: No bubble, plain text
- **"Thought for Xs"**: Link color, clickable to expand
- **...** per message: Copy, regenerate options

### Input Footer
```
┌─────────────────────────────────────────┐
│ Plan, @ for context, / for commands     │
├─────────────────────────────────────────┤
│ [💬 Ask ▼] [Model Name ▼]       [◔] [@] │
└─────────────────────────────────────────┘
```
- **Mode selector**: "Ask" with chat icon (only mode for now)
- **Model selector**: Shows all installed models
- **Context circle** (◔): Shows %, hover for tooltip "4.2% · 8.5K / 204.8K context used"
- **@ button**: Disabled for now

### Model Dropdown
```
┌─────────────────────────────────────────┐
│ llama3.2                                │
│ deepseek-r1         🧠                  │  ← Brain = thinking capable
│ qwen3               🧠  ✓               │  ← Checkmark = selected
├─────────────────────────────────────────┤
│ Add Models                         →    │
└─────────────────────────────────────────┘
```

---

## Directory Structure

```
ollama-chat/
├── src/
│   ├── extension.ts           # Activation, commands, Ollama detection
│   ├── sidebarProvider.ts     # Webview sidebar provider
│   ├── ollamaClient.ts        # Ollama API client
│   ├── ollamaService.ts       # Start/stop Ollama, health checks
│   ├── chatManager.ts         # Multi-chat & persistence
│   ├── contextTracker.ts      # Track token usage per conversation
│   └── webview/
│       ├── index.html         # Chat UI template
│       ├── styles.css         # VS Code theme variables only
│       └── main.js            # Frontend logic
├── media/                     # Icons (chat, clock, plus, etc.)
├── package.json
├── tsconfig.json
└── webpack.config.js
```

---

## Implementation Steps

### Step 1: Project Setup
```bash
yo code  # Select TypeScript + Webpack
```

**package.json contributions:**
```json
{
  "contributes": {
    "viewsContainers": {
      "activitybar": [{
        "id": "ollama-chat",
        "title": "Ollama Chat",
        "icon": "media/chat.svg"
      }]
    },
    "views": {
      "ollama-chat": [{
        "type": "webview",
        "id": "ollamaChat.chatView",
        "name": "Chat"
      }]
    },
    "commands": [
      { "command": "ollamaChat.newChat", "title": "New Chat" },
      { "command": "ollamaChat.sendSelection", "title": "Send to Ollama Chat" }
    ],
    "menus": {
      "editor/context": [{
        "command": "ollamaChat.sendSelection",
        "group": "navigation"
      }]
    }
  }
}
```

### Step 2: Ollama Service (Detection & Auto-Start)

**File: `src/ollamaService.ts`**

```typescript
import * as vscode from 'vscode';
import { exec, spawn } from 'child_process';

export class OllamaService {
  private baseUrl = 'http://localhost:11434';

  async isRunning(): Promise<boolean> {
    try {
      const res = await fetch(this.baseUrl);
      return res.ok;
    } catch {
      return false;
    }
  }

  async isInstalled(): Promise<boolean> {
    return new Promise(resolve => {
      exec('which ollama', err => resolve(!err));
    });
  }

  async startServer(): Promise<void> {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Starting Ollama...",
      cancellable: false
    }, async () => {
      const process = spawn('ollama', ['serve'], {
        detached: true,
        stdio: 'ignore'
      });
      process.unref();
      await this.waitForReady();
    });
  }

  private async waitForReady(timeout = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await this.isRunning()) return;
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('Ollama failed to start');
  }

  async ensureRunning(): Promise<boolean> {
    if (await this.isRunning()) return true;

    if (!(await this.isInstalled())) {
      vscode.window.showErrorMessage(
        'Ollama is not installed. Please install from https://ollama.ai'
      );
      return false;
    }

    const action = await vscode.window.showInformationMessage(
      'Ollama is not running. Start it now?',
      'Start Ollama'
    );

    if (action === 'Start Ollama') {
      await this.startServer();
      return true;
    }
    return false;
  }
}
```

### Step 3: Ollama Client

**File: `src/ollamaClient.ts`**

```typescript
export interface Model {
  name: string;
  loaded: boolean;
  contextLength: number;
  supportsThinking: boolean;
}

export interface ChatChunk {
  content: string;
  thinking: string;
  done: boolean;
  promptTokens?: number;
  evalTokens?: number;
}

export class OllamaClient {
  private baseUrl = 'http://localhost:11434';

  async listModels(): Promise<Model[]> {
    const [tagsRes, psRes] = await Promise.all([
      fetch(`${this.baseUrl}/api/tags`),
      fetch(`${this.baseUrl}/api/ps`)
    ]);

    const tags = await tagsRes.json();
    const ps = await psRes.json();

    const loadedSet = new Set(ps.models?.map((m: any) => m.model) || []);
    const thinkingFamilies = ['deepseek', 'qwen', 'gpt-oss'];

    return (tags.models || []).map((m: any) => ({
      name: m.name,
      loaded: loadedSet.has(m.name),
      contextLength: 4096, // Default, updated via getModelInfo
      supportsThinking: thinkingFamilies.some(f =>
        m.details?.family?.toLowerCase().includes(f)
      )
    }));
  }

  async getModelInfo(model: string): Promise<{ contextLength: number; family: string }> {
    const res = await fetch(`${this.baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model })
    });
    const data = await res.json();
    return {
      contextLength: data.model_info?.context_length || 4096,
      family: data.details?.family || ''
    };
  }

  async *chatStream(
    model: string,
    messages: Array<{ role: string; content: string }>,
    think = true
  ): AsyncGenerator<ChatChunk> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, think })
    });

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      for (const line of decoder.decode(value).split('\n')) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line);
        yield {
          content: chunk.message?.content || '',
          thinking: chunk.message?.thinking || '',
          done: chunk.done || false,
          promptTokens: chunk.prompt_eval_count,
          evalTokens: chunk.eval_count
        };
      }
    }
  }
}
```

### Step 4: Context Tracker

**File: `src/contextTracker.ts`**

```typescript
export class ContextTracker {
  private tokenCounts = new Map<string, { used: number; total: number }>();

  update(chatId: string, promptTokens: number, evalTokens: number, total: number) {
    this.tokenCounts.set(chatId, {
      used: promptTokens + evalTokens,
      total
    });
  }

  getUsage(chatId: string): { percent: number; used: number; total: number } {
    const { used, total } = this.tokenCounts.get(chatId) || { used: 0, total: 4096 };
    return {
      percent: Math.round((used / total) * 1000) / 10,
      used,
      total
    };
  }

  formatDisplay(chatId: string): string {
    const { percent, used, total } = this.getUsage(chatId);
    return `${percent}% · ${this.formatK(used)} / ${this.formatK(total)} context used`;
  }

  private formatK(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
  }
}
```

### Step 5: Chat Manager

**File: `src/chatManager.ts`**

```typescript
import * as vscode from 'vscode';
import { v4 as uuid } from 'uuid';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  thinkingTime?: number;
  timestamp: Date;
}

export interface Chat {
  id: string;
  title: string;
  model: string;
  createdAt: Date;
  messages: Message[];
  contextUsed: number;
  contextTotal: number;
}

export class ChatManager {
  private chats: Chat[] = [];
  private activeId: string | null = null;

  constructor(private context: vscode.ExtensionContext) {
    this.load();
  }

  createChat(model: string): Chat {
    const chat: Chat = {
      id: uuid(),
      title: 'New Chat',
      model,
      createdAt: new Date(),
      messages: [],
      contextUsed: 0,
      contextTotal: 4096
    };
    this.chats.unshift(chat);
    this.activeId = chat.id;
    this.save();
    return chat;
  }

  getActive(): Chat | null {
    return this.chats.find(c => c.id === this.activeId) || null;
  }

  setActive(id: string) {
    this.activeId = id;
  }

  getAll(): Chat[] {
    return this.chats;
  }

  renameChat(id: string, title: string) {
    const chat = this.chats.find(c => c.id === id);
    if (chat) {
      chat.title = title;
      this.save();
    }
  }

  deleteChat(id: string) {
    this.chats = this.chats.filter(c => c.id !== id);
    if (this.activeId === id) {
      this.activeId = this.chats[0]?.id || null;
    }
    this.save();
  }

  addMessage(chatId: string, msg: Message) {
    const chat = this.chats.find(c => c.id === chatId);
    if (chat) {
      chat.messages.push(msg);
      if (chat.messages.length === 1 && msg.role === 'user') {
        chat.title = msg.content.slice(0, 40) + (msg.content.length > 40 ? '...' : '');
      }
      this.save();
    }
  }

  searchChats(query: string): Chat[] {
    const q = query.toLowerCase();
    return this.chats.filter(c =>
      c.title.toLowerCase().includes(q) ||
      c.messages.some(m => m.content.toLowerCase().includes(q))
    );
  }

  getChatsGroupedByDate(): { today: Chat[]; yesterday: Chat[]; older: Chat[] } {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);

    return {
      today: this.chats.filter(c => new Date(c.createdAt) >= today),
      yesterday: this.chats.filter(c => {
        const d = new Date(c.createdAt);
        return d >= yesterday && d < today;
      }),
      older: this.chats.filter(c => new Date(c.createdAt) < yesterday)
    };
  }

  private load() {
    const data = this.context.globalState.get<Chat[]>('ollama-chats', []);
    this.chats = data.map(c => ({
      ...c,
      createdAt: new Date(c.createdAt),
      messages: c.messages.map(m => ({ ...m, timestamp: new Date(m.timestamp) }))
    }));
    this.activeId = this.chats[0]?.id || null;
  }

  private save() {
    this.context.globalState.update('ollama-chats', this.chats);
  }
}
```

### Step 6: Sidebar Provider

**File: `src/sidebarProvider.ts`**

```typescript
import * as vscode from 'vscode';
import { OllamaClient } from './ollamaClient';
import { OllamaService } from './ollamaService';
import { ChatManager, Message } from './chatManager';
import { ContextTracker } from './contextTracker';

export class OllamaChatProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private selectedModel = '';

  constructor(
    private context: vscode.ExtensionContext,
    private ollamaService: OllamaService,
    private ollamaClient: OllamaClient,
    private chatManager: ChatManager,
    private contextTracker: ContextTracker
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async msg => {
      switch (msg.type) {
        case 'ready':
          await this.initialize();
          break;
        case 'sendMessage':
          await this.handleSendMessage(msg.text);
          break;
        case 'newChat':
          this.chatManager.createChat(this.selectedModel);
          this.refresh();
          break;
        case 'selectChat':
          this.chatManager.setActive(msg.id);
          this.refresh();
          break;
        case 'selectModel':
          this.selectedModel = msg.model;
          break;
        case 'deleteChat':
          this.chatManager.deleteChat(msg.id);
          this.refresh();
          break;
        case 'renameChat':
          this.chatManager.renameChat(msg.id, msg.title);
          this.refresh();
          break;
        case 'searchChats':
          const results = this.chatManager.searchChats(msg.query);
          this.postMessage({ type: 'searchResults', chats: results });
          break;
      }
    });
  }

  private async initialize() {
    if (!(await this.ollamaService.ensureRunning())) return;

    const models = await this.ollamaClient.listModels();
    if (models.length > 0 && !this.selectedModel) {
      this.selectedModel = models[0].name;
    }

    let activeChat = this.chatManager.getActive();
    if (!activeChat) {
      activeChat = this.chatManager.createChat(this.selectedModel);
    }

    this.postMessage({
      type: 'init',
      models,
      selectedModel: this.selectedModel,
      chat: activeChat,
      allChats: this.chatManager.getChatsGroupedByDate()
    });
  }

  private async handleSendMessage(text: string) {
    const chat = this.chatManager.getActive();
    if (!chat) return;

    const userMsg: Message = {
      role: 'user',
      content: text,
      timestamp: new Date()
    };
    this.chatManager.addMessage(chat.id, userMsg);
    this.postMessage({ type: 'addMessage', message: userMsg });

    let thinking = '';
    let content = '';
    const startTime = Date.now();

    try {
      for await (const chunk of this.ollamaClient.chatStream(
        chat.model,
        chat.messages.map(m => ({ role: m.role, content: m.content }))
      )) {
        if (chunk.thinking) thinking += chunk.thinking;
        if (chunk.content) content += chunk.content;

        this.postMessage({
          type: 'streamUpdate',
          thinking,
          content,
          thinkingTime: Math.round((Date.now() - startTime) / 1000)
        });

        if (chunk.done && chunk.promptTokens && chunk.evalTokens) {
          this.contextTracker.update(
            chat.id,
            chunk.promptTokens,
            chunk.evalTokens,
            chat.contextTotal
          );
          this.postMessage({
            type: 'contextUpdate',
            display: this.contextTracker.formatDisplay(chat.id),
            usage: this.contextTracker.getUsage(chat.id)
          });
        }
      }

      const assistantMsg: Message = {
        role: 'assistant',
        content,
        thinking: thinking || undefined,
        thinkingTime: thinking ? Math.round((Date.now() - startTime) / 1000) : undefined,
        timestamp: new Date()
      };
      this.chatManager.addMessage(chat.id, assistantMsg);
      this.postMessage({ type: 'streamComplete', message: assistantMsg });
    } catch (error) {
      this.postMessage({ type: 'error', message: String(error) });
    }
  }

  private refresh() {
    const chat = this.chatManager.getActive();
    this.postMessage({
      type: 'refresh',
      chat,
      allChats: this.chatManager.getChatsGroupedByDate()
    });
  }

  private postMessage(message: any) {
    this.view?.webview.postMessage(message);
  }

  public sendToChat(text: string) {
    this.postMessage({ type: 'insertText', text });
  }

  private getHtmlContent(webview: vscode.Webview): string {
    // Returns the full HTML content - see webview/index.html
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    /* All styles use VS Code theme variables - see styles section */
  </style>
</head>
<body>
  <!-- Chat UI structure - see index.html section -->
  <script>
    // Frontend logic - see main.js section
  </script>
</body>
</html>`;
  }
}
```

### Step 7: Webview UI (VS Code Theme Variables)

**File: `src/webview/styles.css`**

Uses only VS Code CSS variables - adapts to any theme automatically:

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  height: 100vh;
  display: flex;
  flex-direction: column;
}

/* Header */
.header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--vscode-panel-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.chat-title {
  font-weight: 600;
  font-size: 14px;
}

.header-buttons {
  display: flex;
  gap: 8px;
}

.icon-button {
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
}

.icon-button:hover {
  background: var(--vscode-list-hoverBackground);
}

.subheader {
  padding: 4px 16px 8px;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

/* Messages */
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.message {
  margin-bottom: 16px;
}

.user-message .content {
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 8px;
  padding: 12px 16px;
}

.assistant-message .content {
  padding: 8px 0;
}

.thinking-label {
  color: var(--vscode-textLink-foreground);
  font-size: 12px;
  cursor: pointer;
  margin-bottom: 8px;
}

.thinking-label:hover {
  color: var(--vscode-textLink-activeForeground);
}

.thinking-content {
  display: none;
  background: var(--vscode-textBlockQuote-background);
  border-left: 3px solid var(--vscode-textLink-foreground);
  padding: 8px 12px;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.thinking-content.expanded {
  display: block;
}

.message-options {
  opacity: 0;
  transition: opacity 0.2s;
}

.message:hover .message-options {
  opacity: 1;
}

/* Input Footer */
.input-footer {
  border-top: 1px solid var(--vscode-panel-border);
  padding: 12px 16px;
}

.input-wrapper {
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 8px;
  padding: 8px 12px;
}

.input-wrapper:focus-within {
  border-color: var(--vscode-focusBorder);
}

textarea {
  width: 100%;
  background: transparent;
  border: none;
  color: var(--vscode-input-foreground);
  font-family: inherit;
  font-size: inherit;
  resize: none;
  outline: none;
}

textarea::placeholder {
  color: var(--vscode-input-placeholderForeground);
}

.input-controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
}

/* Dropdowns */
.dropdown-button {
  background: var(--vscode-dropdown-background);
  border: 1px solid var(--vscode-dropdown-border);
  color: var(--vscode-dropdown-foreground);
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.dropdown-button:hover {
  background: var(--vscode-list-hoverBackground);
}

.dropdown-menu {
  position: absolute;
  background: var(--vscode-dropdown-background);
  border: 1px solid var(--vscode-dropdown-border);
  border-radius: 4px;
  box-shadow: 0 2px 8px var(--vscode-widget-shadow);
  z-index: 100;
  min-width: 200px;
}

.dropdown-item {
  padding: 8px 12px;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.dropdown-item:hover {
  background: var(--vscode-list-hoverBackground);
}

.dropdown-item.selected {
  background: var(--vscode-list-activeSelectionBackground);
}

/* Context indicator */
.context-indicator {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid var(--vscode-panel-border);
  position: relative;
  cursor: pointer;
}

.context-fill {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: conic-gradient(
    var(--vscode-textLink-foreground) var(--context-percent),
    transparent var(--context-percent)
  );
}

.context-tooltip {
  position: absolute;
  bottom: 100%;
  right: 0;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-editorWidget-border);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 11px;
  white-space: nowrap;
  display: none;
}

.context-indicator:hover .context-tooltip {
  display: block;
}

/* Chat History Panel */
.history-panel {
  position: absolute;
  top: 0;
  right: 0;
  width: 280px;
  height: 100%;
  background: var(--vscode-sideBar-background);
  border-left: 1px solid var(--vscode-panel-border);
  z-index: 50;
  display: none;
}

.history-panel.open {
  display: block;
}

.history-search {
  padding: 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.history-search input {
  width: 100%;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  color: var(--vscode-input-foreground);
  padding: 6px 10px;
  border-radius: 4px;
}

.history-group-title {
  padding: 8px 12px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase;
}

.history-item {
  padding: 8px 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
}

.history-item:hover {
  background: var(--vscode-list-hoverBackground);
}

.history-item.current {
  background: var(--vscode-list-activeSelectionBackground);
}

.history-item-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
}

.history-item:hover .history-item-actions {
  opacity: 1;
}

.badge {
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  padding: 2px 6px;
  border-radius: 10px;
  font-size: 10px;
}
```

### Step 8: Extension Entry Point

**File: `src/extension.ts`**

```typescript
import * as vscode from 'vscode';
import { OllamaService } from './ollamaService';
import { OllamaClient } from './ollamaClient';
import { ChatManager } from './chatManager';
import { ContextTracker } from './contextTracker';
import { OllamaChatProvider } from './sidebarProvider';

let chatProvider: OllamaChatProvider;

export function activate(context: vscode.ExtensionContext) {
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

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'ollamaChat.chatView',
      chatProvider
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ollamaChat.newChat', () => {
      chatProvider.sendToChat('');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ollamaChat.sendSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.document.getText(editor.selection);
      if (selection) {
        chatProvider.sendToChat('```\n' + selection + '\n```');
      }
    })
  );
}

export function deactivate() {}
```

---

## Distribution

1. **Build**: `npm run package` → `ollama-chat-0.1.0.vsix`
2. **Share**: Upload to GitHub releases
3. **Install**: `code --install-extension ollama-chat-0.1.0.vsix`
4. **Optional**: Publish to VS Code Marketplace (free)

---

## File Summary

| File | Purpose | ~Lines |
|------|---------|--------|
| `extension.ts` | Entry point, commands | 60 |
| `sidebarProvider.ts` | Webview provider | 180 |
| `ollamaClient.ts` | API client | 100 |
| `ollamaService.ts` | Start/detect Ollama | 70 |
| `chatManager.ts` | Chat CRUD + persistence | 130 |
| `contextTracker.ts` | Token tracking | 40 |
| `webview/index.html` | Chat UI structure | 120 |
| `webview/styles.css` | VS Code theme styling | 250 |
| `webview/main.js` | Frontend logic | 200 |
| `package.json` | Extension manifest | 80 |

**Total: ~1230 lines**

---

## Included Features
- Auto-detect and start Ollama
- Model load status indicator
- Context window tracking with visual %
- Thinking/reasoning display (expandable)
- Chat history with search
- Create/rename/delete chats
- Streaming responses
- Editor text selection → chat
- Persistence across restarts
- **Adapts to any VS Code theme**

## Not Included (Keep Simple)
- Temperature/parameter settings
- @ context adding
- Voice dictation
- Web search
- Code apply/diff actions
