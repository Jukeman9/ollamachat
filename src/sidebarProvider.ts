import * as vscode from 'vscode';
import { OllamaClient, Model } from './ollamaClient';
import { OllamaService } from './ollamaService';
import { ChatManager, Message } from './chatManager';
import { ContextTracker } from './contextTracker';

export class OllamaChatProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private selectedModel = '';
  private models: Model[] = [];

  constructor(
    private context: vscode.ExtensionContext,
    private ollamaService: OllamaService,
    private ollamaClient: OllamaClient,
    private chatManager: ChatManager,
    private contextTracker: ContextTracker
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    webviewView.webview.html = this.getHtmlContent();

    webviewView.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      switch (msg.type) {
        case 'ready':
          await this.initialize();
          break;
        case 'sendMessage':
          await this.handleSendMessage(msg.text!);
          break;
        case 'newChat':
          this.chatManager.createChat(this.selectedModel);
          this.refresh();
          break;
        case 'selectChat':
          this.chatManager.setActive(msg.id!);
          this.refresh();
          break;
        case 'selectModel':
          this.selectedModel = msg.model!;
          const active = this.chatManager.getActive();
          if (active) {
            this.chatManager.updateModel(active.id, this.selectedModel);
            // Update context length for new model
            const modelInfo = await this.ollamaClient.getModelInfo(this.selectedModel);
            this.contextTracker.setTotal(active.id, modelInfo.contextLength);
          }
          break;
        case 'deleteChat':
          this.chatManager.deleteChat(msg.id!);
          this.refresh();
          break;
        case 'renameChat':
          this.chatManager.renameChat(msg.id!, msg.title!);
          this.refresh();
          break;
        case 'searchChats':
          const results = this.chatManager.searchChats(msg.query!);
          this.postMessage({ type: 'searchResults', chats: results });
          break;
        case 'stopGeneration':
          // TODO: Implement AbortController for stopping generation
          break;
      }
    });
  }

  private async initialize(): Promise<void> {
    if (!(await this.ollamaService.ensureRunning())) {
      this.postMessage({ type: 'error', message: 'Ollama is not running' });
      return;
    }

    try {
      this.models = await this.ollamaClient.listModels();
      if (this.models.length > 0 && !this.selectedModel) {
        this.selectedModel = this.models[0].name;
      }

      let activeChat = this.chatManager.getActive();
      if (!activeChat) {
        activeChat = this.chatManager.createChat(this.selectedModel);
      } else {
        this.selectedModel = activeChat.model;
      }

      // Get context length for current model
      if (this.selectedModel) {
        const modelInfo = await this.ollamaClient.getModelInfo(this.selectedModel);
        this.contextTracker.setTotal(activeChat.id, modelInfo.contextLength);
        this.chatManager.updateContext(activeChat.id, activeChat.contextUsed, modelInfo.contextLength);
      }

      this.postMessage({
        type: 'init',
        models: this.models,
        selectedModel: this.selectedModel,
        chat: activeChat,
        allChats: this.chatManager.getChatsGroupedByDate(),
        contextDisplay: this.contextTracker.formatDisplay(activeChat.id),
        contextUsage: this.contextTracker.getUsage(activeChat.id)
      });
    } catch (error) {
      this.postMessage({ type: 'error', message: `Failed to initialize: ${error}` });
    }
  }

  private async handleSendMessage(text: string): Promise<void> {
    const chat = this.chatManager.getActive();
    if (!chat || !text.trim()) return;

    const userMsg: Message = {
      role: 'user',
      content: text.trim(),
      timestamp: new Date()
    };
    this.chatManager.addMessage(chat.id, userMsg);
    this.postMessage({ type: 'addMessage', message: userMsg });

    let thinking = '';
    let content = '';
    const startTime = Date.now();
    let lastThinkingTime = 0;

    try {
      this.postMessage({ type: 'streamStart' });

      const messages = chat.messages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content
      }));

      // Check if model supports thinking
      const model = this.models.find(m => m.name === chat.model);
      const supportsThinking = model?.supportsThinking ?? false;

      for await (const chunk of this.ollamaClient.chatStream(
        chat.model,
        messages,
        supportsThinking
      )) {
        if (chunk.thinking) {
          thinking += chunk.thinking;
          lastThinkingTime = Math.round((Date.now() - startTime) / 1000);
        }
        if (chunk.content) {
          content += chunk.content;
        }

        this.postMessage({
          type: 'streamUpdate',
          thinking,
          content,
          thinkingTime: lastThinkingTime
        });

        if (chunk.done && chunk.promptTokens !== undefined && chunk.evalTokens !== undefined) {
          const modelInfo = await this.ollamaClient.getModelInfo(chat.model);
          this.contextTracker.update(
            chat.id,
            chunk.promptTokens,
            chunk.evalTokens,
            modelInfo.contextLength
          );
          this.chatManager.updateContext(
            chat.id,
            chunk.promptTokens + chunk.evalTokens,
            modelInfo.contextLength
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
        thinkingTime: thinking ? lastThinkingTime : undefined,
        timestamp: new Date()
      };
      this.chatManager.addMessage(chat.id, assistantMsg);
      this.postMessage({ type: 'streamComplete', message: assistantMsg });
    } catch (error) {
      this.postMessage({ type: 'error', message: String(error) });
      this.postMessage({ type: 'streamComplete' });
    }
  }

  private refresh(): void {
    const chat = this.chatManager.getActive();
    if (chat) {
      this.selectedModel = chat.model;
    }
    this.postMessage({
      type: 'refresh',
      chat,
      allChats: this.chatManager.getChatsGroupedByDate(),
      selectedModel: this.selectedModel,
      contextDisplay: chat ? this.contextTracker.formatDisplay(chat.id) : '',
      contextUsage: chat ? this.contextTracker.getUsage(chat.id) : { percent: 0, used: 0, total: 4096 }
    });
  }

  private postMessage(message: object): void {
    this.view?.webview.postMessage(message);
  }

  public sendToChat(text: string): void {
    if (text) {
      this.postMessage({ type: 'insertText', text });
    }
  }

  public newChat(): void {
    this.chatManager.createChat(this.selectedModel);
    this.refresh();
  }

  private getHtmlContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    :root {
      --accent-green: #4ade80;
    }

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
      overflow: hidden;
    }

    /* Header */
    .header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-shrink: 0;
    }

    .chat-title {
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chat-title:hover {
      color: var(--vscode-textLink-foreground);
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
      padding: 4px 6px;
      border-radius: 4px;
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .icon-button:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .icon-button svg {
      width: 16px;
      height: 16px;
    }

    .icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      vertical-align: middle;
    }

    .icon svg {
      width: 16px;
      height: 16px;
    }

    .icon-sm svg {
      width: 14px;
      height: 14px;
    }

    .icon-lg svg {
      width: 48px;
      height: 48px;
      opacity: 0.5;
    }

    .subheader {
      padding: 4px 16px 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }

    /* Messages */
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
    }

    .message {
      margin-bottom: 16px;
      position: relative;
    }

    .user-message .content {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 8px;
      padding: 12px 16px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .assistant-message .content {
      padding: 8px 0;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .thinking-label {
      color: var(--vscode-textLink-foreground);
      font-size: 12px;
      cursor: pointer;
      margin-bottom: 8px;
      display: inline-block;
    }

    .thinking-label:hover {
      color: var(--vscode-textLink-activeForeground);
      text-decoration: underline;
    }

    .thinking-content {
      display: none;
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textLink-foreground);
      padding: 8px 12px;
      margin-bottom: 8px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      white-space: pre-wrap;
      max-height: 200px;
      overflow-y: auto;
    }

    .thinking-content.expanded {
      display: block;
    }

    .message-options {
      position: absolute;
      top: 0;
      right: 0;
      opacity: 0;
      transition: opacity 0.2s;
      display: flex;
      gap: 4px;
    }

    .message:hover .message-options {
      opacity: 1;
    }

    /* Streaming indicator */
    .streaming-indicator {
      display: inline-block;
      width: 8px;
      height: 14px;
      background: var(--vscode-textLink-foreground);
      animation: blink 1s infinite;
      margin-left: 2px;
      vertical-align: text-bottom;
    }

    @keyframes blink {
      0%, 50% { opacity: 1; }
      51%, 100% { opacity: 0; }
    }

    /* Input Footer */
    .input-footer {
      border-top: 1px solid var(--vscode-panel-border);
      padding: 12px 16px;
      flex-shrink: 0;
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
      min-height: 24px;
      max-height: 150px;
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

    .input-left {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .input-right {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    /* Dropdowns */
    .dropdown-container {
      position: relative;
    }

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

    .dropdown-button.active {
      color: var(--accent-green);
    }

    .dropdown-menu {
      position: absolute;
      bottom: 100%;
      left: 0;
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 4px;
      box-shadow: 0 2px 8px var(--vscode-widget-shadow);
      z-index: 100;
      min-width: 200px;
      max-height: 300px;
      overflow-y: auto;
      display: none;
      margin-bottom: 4px;
    }

    .dropdown-menu.open {
      display: block;
    }

    .dropdown-item {
      padding: 8px 12px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
    }

    .dropdown-item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .dropdown-item.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }

    .dropdown-separator {
      border-top: 1px solid var(--vscode-panel-border);
      margin: 4px 0;
    }

    .model-icons {
      display: flex;
      gap: 4px;
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
      overflow: hidden;
      background: conic-gradient(
        var(--accent-green) calc(var(--context-percent) * 1%),
        transparent calc(var(--context-percent) * 1%)
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
      margin-bottom: 4px;
      z-index: 100;
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
      flex-direction: column;
    }

    .history-panel.open {
      display: flex;
    }

    .history-header {
      padding: 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .history-header h3 {
      font-size: 14px;
      font-weight: 600;
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
      font-size: 12px;
    }

    .history-search input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    .history-list {
      flex: 1;
      overflow-y: auto;
    }

    .history-group-title {
      padding: 8px 12px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      font-weight: 600;
    }

    .history-item {
      padding: 8px 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      gap: 8px;
    }

    .history-item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .history-item.current {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }

    .history-item-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }

    .history-item-time {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
    }

    .history-item-actions {
      display: flex;
      gap: 4px;
      opacity: 0;
      flex-shrink: 0;
    }

    .history-item:hover .history-item-actions {
      opacity: 1;
    }

    .badge {
      background: var(--accent-green);
      color: #000;
      padding: 2px 6px;
      border-radius: 10px;
      font-size: 10px;
      margin-left: 4px;
    }

    /* Empty state */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      padding: 20px;
    }

    .empty-state-icon {
      font-size: 48px;
      margin-bottom: 16px;
      opacity: 0.5;
    }

    /* Loading state */
    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--vscode-descriptionForeground);
    }

    .hidden {
      display: none !important;
    }

    /* Code blocks */
    pre, code {
      font-family: var(--vscode-editor-font-family);
      background: var(--vscode-textCodeBlock-background);
      border-radius: 4px;
    }

    pre {
      padding: 8px 12px;
      overflow-x: auto;
    }

    code {
      padding: 2px 4px;
    }

    pre code {
      padding: 0;
      background: none;
    }
  </style>
</head>
<body>
  <div class="header">
    <span class="chat-title" id="chatTitle" title="Click to rename">New Chat</span>
    <div class="header-buttons">
      <button class="icon-button" id="newChatBtn" title="New Chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>
      <button class="icon-button" id="historyBtn" title="Chat History"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg></button>
      <button class="icon-button" id="settingsBtn" title="Settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle></svg></button>
    </div>
  </div>

  <div class="subheader">
    <span id="timestamp">Now</span> · <span id="modelName">Loading...</span>
  </div>

  <div class="messages" id="messages">
    <div class="loading" id="loadingState">Loading...</div>
  </div>

  <div class="input-footer">
    <div class="input-wrapper">
      <textarea
        id="messageInput"
        placeholder="Plan, @ for context, / for commands"
        rows="1"
      ></textarea>
    </div>
    <div class="input-controls">
      <div class="input-left">
        <div class="dropdown-container">
          <button class="dropdown-button active" id="modeBtn"><span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></span> Ask <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"></path></svg></button>
        </div>
        <div class="dropdown-container">
          <button class="dropdown-button" id="modelBtn">
            <span id="selectedModelName">Select Model</span> <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"></path></svg>
          </button>
          <div class="dropdown-menu" id="modelDropdown"></div>
        </div>
      </div>
      <div class="input-right">
        <div class="context-indicator" id="contextIndicator" style="--context-percent: 0">
          <div class="context-fill"></div>
          <div class="context-tooltip" id="contextTooltip">0% · 0 / 4K context used</div>
        </div>
        <button class="icon-button" id="atBtn" title="Add context (coming soon)" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"></path></svg></button>
        <button class="icon-button" id="globeBtn" title="Web search (coming soon)" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path><path d="M2 12h20"></path></svg></button>
        <button class="icon-button" id="micBtn" title="Voice input (coming soon)" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg></button>
      </div>
    </div>
  </div>

  <div class="history-panel" id="historyPanel">
    <div class="history-header">
      <h3>Chat History</h3>
      <button class="icon-button" id="closeHistoryBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
    </div>
    <div class="history-search">
      <input type="text" id="historySearch" placeholder="Search chats...">
    </div>
    <div class="history-list" id="historyList"></div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    let state = {
      models: [],
      selectedModel: '',
      chat: null,
      allChats: { today: [], yesterday: [], older: [] },
      isStreaming: false,
      streamingContent: '',
      streamingThinking: '',
      thinkingExpanded: false
    };

    // DOM Elements
    const chatTitle = document.getElementById('chatTitle');
    const timestamp = document.getElementById('timestamp');
    const modelName = document.getElementById('modelName');
    const messages = document.getElementById('messages');
    const loadingState = document.getElementById('loadingState');
    const messageInput = document.getElementById('messageInput');
    const modelBtn = document.getElementById('modelBtn');
    const modelDropdown = document.getElementById('modelDropdown');
    const selectedModelName = document.getElementById('selectedModelName');
    const contextIndicator = document.getElementById('contextIndicator');
    const contextTooltip = document.getElementById('contextTooltip');
    const historyPanel = document.getElementById('historyPanel');
    const historyList = document.getElementById('historyList');
    const historySearch = document.getElementById('historySearch');

    // Initialize
    vscode.postMessage({ type: 'ready' });

    // Message handlers
    window.addEventListener('message', event => {
      const msg = event.data;

      switch (msg.type) {
        case 'init':
          state.models = msg.models;
          state.selectedModel = msg.selectedModel;
          state.chat = msg.chat;
          state.allChats = msg.allChats;
          loadingState.classList.add('hidden');
          updateUI();
          updateContextDisplay(msg.contextUsage, msg.contextDisplay);
          break;

        case 'refresh':
          state.chat = msg.chat;
          state.allChats = msg.allChats;
          state.selectedModel = msg.selectedModel;
          updateUI();
          updateContextDisplay(msg.contextUsage, msg.contextDisplay);
          break;

        case 'addMessage':
          appendMessage(msg.message);
          break;

        case 'streamStart':
          state.isStreaming = true;
          state.streamingContent = '';
          state.streamingThinking = '';
          appendStreamingMessage();
          break;

        case 'streamUpdate':
          state.streamingContent = msg.content;
          state.streamingThinking = msg.thinking;
          updateStreamingMessage(msg.content, msg.thinking, msg.thinkingTime);
          break;

        case 'streamComplete':
          state.isStreaming = false;
          if (msg.message) {
            finalizeStreamingMessage(msg.message);
          } else {
            removeStreamingMessage();
          }
          break;

        case 'contextUpdate':
          updateContextDisplay(msg.usage, msg.display);
          break;

        case 'searchResults':
          renderHistoryList(groupChatsByDate(msg.chats));
          break;

        case 'error':
          showError(msg.message);
          break;

        case 'insertText':
          messageInput.value = msg.text;
          messageInput.focus();
          autoResize(messageInput);
          break;
      }
    });

    // UI Update functions
    function updateUI() {
      if (!state.chat) return;

      chatTitle.textContent = state.chat.title;
      modelName.textContent = state.selectedModel;
      selectedModelName.textContent = state.selectedModel || 'Select Model';
      timestamp.textContent = formatTimestamp(state.chat.createdAt);

      renderMessages();
      renderModelDropdown();
      renderHistoryList(state.allChats);
    }

    function renderMessages() {
      if (!state.chat) return;

      messages.innerHTML = '';

      if (state.chat.messages.length === 0) {
        messages.innerHTML = \`
          <div class="empty-state">
            <div class="empty-state-icon icon-lg"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></div>
            <p>Start a conversation with \${state.selectedModel || 'Ollama'}</p>
          </div>
        \`;
        return;
      }

      state.chat.messages.forEach(msg => {
        appendMessage(msg, false);
      });

      scrollToBottom();
    }

    function appendMessage(msg, scroll = true) {
      const emptyState = messages.querySelector('.empty-state');
      if (emptyState) emptyState.remove();

      const div = document.createElement('div');
      div.className = \`message \${msg.role}-message\`;

      let html = '';

      if (msg.role === 'assistant' && msg.thinking) {
        const thinkingId = 'thinking-' + Date.now();
        html += \`
          <div class="thinking-label" onclick="toggleThinking('\${thinkingId}')">
            Thought for \${msg.thinkingTime || 0}s ▶
          </div>
          <div class="thinking-content" id="\${thinkingId}">\${escapeHtml(msg.thinking)}</div>
        \`;
      }

      html += \`<div class="content">\${formatContent(msg.content)}</div>\`;

      html += \`
        <div class="message-options">
          <button class="icon-button" onclick="copyMessage(this)" title="Copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>
        </div>
      \`;

      div.innerHTML = html;
      messages.appendChild(div);

      if (scroll) scrollToBottom();
    }

    function appendStreamingMessage() {
      const emptyState = messages.querySelector('.empty-state');
      if (emptyState) emptyState.remove();

      const div = document.createElement('div');
      div.className = 'message assistant-message';
      div.id = 'streaming-message';
      div.innerHTML = '<div class="content"><span class="streaming-indicator"></span></div>';
      messages.appendChild(div);
      scrollToBottom();
    }

    function updateStreamingMessage(content, thinking, thinkingTime) {
      const div = document.getElementById('streaming-message');
      if (!div) return;

      let html = '';

      if (thinking) {
        const thinkingId = 'streaming-thinking';
        const expandedClass = state.thinkingExpanded ? 'expanded' : '';
        const arrow = state.thinkingExpanded ? '▼' : '▶';
        html += \`
          <div class="thinking-label" onclick="toggleStreamingThinking()">
            Thought for \${thinkingTime || 0}s \${arrow}
          </div>
          <div class="thinking-content \${expandedClass}" id="\${thinkingId}">\${escapeHtml(thinking)}</div>
        \`;
      }

      html += \`<div class="content">\${formatContent(content)}<span class="streaming-indicator"></span></div>\`;

      div.innerHTML = html;
      scrollToBottom();
    }

    function finalizeStreamingMessage(msg) {
      const div = document.getElementById('streaming-message');
      if (!div) return;

      div.id = '';

      let html = '';

      if (msg.thinking) {
        const thinkingId = 'thinking-' + Date.now();
        html += \`
          <div class="thinking-label" onclick="toggleThinking('\${thinkingId}')">
            Thought for \${msg.thinkingTime || 0}s ▶
          </div>
          <div class="thinking-content" id="\${thinkingId}">\${escapeHtml(msg.thinking)}</div>
        \`;
      }

      html += \`<div class="content">\${formatContent(msg.content)}</div>\`;
      html += \`
        <div class="message-options">
          <button class="icon-button" onclick="copyMessage(this)" title="Copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>
        </div>
      \`;

      div.innerHTML = html;
      state.thinkingExpanded = false;
    }

    function removeStreamingMessage() {
      const div = document.getElementById('streaming-message');
      if (div) div.remove();
    }

    function renderModelDropdown() {
      modelDropdown.innerHTML = state.models.map(m => \`
        <div class="dropdown-item \${m.name === state.selectedModel ? 'selected' : ''}"
             onclick="selectModel('\${m.name}')">
          <span>\${m.name}</span>
          <span class="model-icons">
            \${m.supportsThinking ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"></path><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"></path><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"></path></svg>' : ''}
            \${m.name === state.selectedModel ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>' : ''}
          </span>
        </div>
      \`).join('');

      modelDropdown.innerHTML += \`
        <div class="dropdown-separator"></div>
        <div class="dropdown-item" onclick="openOllamaModels()">
          Add Models →
        </div>
      \`;
    }

    function renderHistoryList(groups) {
      let html = '';

      const renderGroup = (title, chats) => {
        if (chats.length === 0) return '';
        return \`
          <div class="history-group-title">\${title}</div>
          \${chats.map(chat => \`
            <div class="history-item \${state.chat && chat.id === state.chat.id ? 'current' : ''}"
                 onclick="selectChat('\${chat.id}')">
              <span class="history-item-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg> \${escapeHtml(chat.title)}</span>
              \${state.chat && chat.id === state.chat.id ? '<span class="badge">Current</span>' : ''}
              <span class="history-item-time">\${formatRelativeTime(chat.createdAt)}</span>
              <div class="history-item-actions">
                <button class="icon-button" onclick="event.stopPropagation(); renameChat('\${chat.id}')" title="Rename"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path><path d="m15 5 4 4"></path></svg></button>
                <button class="icon-button" onclick="event.stopPropagation(); deleteChat('\${chat.id}')" title="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>
              </div>
            </div>
          \`).join('')}
        \`;
      };

      html += renderGroup('Today', groups.today || []);
      html += renderGroup('Yesterday', groups.yesterday || []);
      html += renderGroup('Older', groups.older || []);

      historyList.innerHTML = html || '<div class="empty-state"><p>No chats yet</p></div>';
    }

    function updateContextDisplay(usage, display) {
      if (!usage) return;
      contextIndicator.style.setProperty('--context-percent', usage.percent);
      contextTooltip.textContent = display || \`\${usage.percent}% · \${formatK(usage.used)} / \${formatK(usage.total)} context used\`;
    }

    // Event handlers
    document.getElementById('newChatBtn').onclick = () => {
      vscode.postMessage({ type: 'newChat' });
    };

    document.getElementById('historyBtn').onclick = () => {
      historyPanel.classList.toggle('open');
    };

    document.getElementById('closeHistoryBtn').onclick = () => {
      historyPanel.classList.remove('open');
    };

    document.getElementById('settingsBtn').onclick = () => {
      alert('No settings yet');
    };

    modelBtn.onclick = (e) => {
      e.stopPropagation();
      modelDropdown.classList.toggle('open');
    };

    document.addEventListener('click', () => {
      modelDropdown.classList.remove('open');
    });

    chatTitle.onclick = () => {
      if (!state.chat) return;
      const newTitle = prompt('Rename chat:', state.chat.title);
      if (newTitle && newTitle.trim()) {
        vscode.postMessage({ type: 'renameChat', id: state.chat.id, title: newTitle.trim() });
      }
    };

    messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    messageInput.addEventListener('input', () => {
      autoResize(messageInput);
    });

    historySearch.addEventListener('input', (e) => {
      const query = e.target.value;
      if (query) {
        vscode.postMessage({ type: 'searchChats', query });
      } else {
        renderHistoryList(state.allChats);
      }
    });

    // Helper functions
    function sendMessage() {
      const text = messageInput.value.trim();
      if (!text || state.isStreaming) return;

      vscode.postMessage({ type: 'sendMessage', text });
      messageInput.value = '';
      autoResize(messageInput);
    }

    function selectModel(model) {
      state.selectedModel = model;
      selectedModelName.textContent = model;
      modelName.textContent = model;
      modelDropdown.classList.remove('open');
      vscode.postMessage({ type: 'selectModel', model });
      renderModelDropdown();
    }

    function selectChat(id) {
      vscode.postMessage({ type: 'selectChat', id });
      historyPanel.classList.remove('open');
    }

    function deleteChat(id) {
      if (confirm('Delete this chat?')) {
        vscode.postMessage({ type: 'deleteChat', id });
      }
    }

    function renameChat(id) {
      const chat = [...state.allChats.today, ...state.allChats.yesterday, ...state.allChats.older]
        .find(c => c.id === id);
      if (!chat) return;

      const newTitle = prompt('Rename chat:', chat.title);
      if (newTitle && newTitle.trim()) {
        vscode.postMessage({ type: 'renameChat', id, title: newTitle.trim() });
      }
    }

    function openOllamaModels() {
      modelDropdown.classList.remove('open');
      // Could open Ollama website or show instructions
      alert('Visit https://ollama.ai/library to find and pull new models.\\n\\nRun: ollama pull <model-name>');
    }

    function toggleThinking(id) {
      const el = document.getElementById(id);
      if (el) {
        el.classList.toggle('expanded');
        const label = el.previousElementSibling;
        if (label) {
          const text = label.textContent;
          label.textContent = el.classList.contains('expanded')
            ? text.replace('▶', '▼')
            : text.replace('▼', '▶');
        }
      }
    }

    function toggleStreamingThinking() {
      state.thinkingExpanded = !state.thinkingExpanded;
      const el = document.getElementById('streaming-thinking');
      if (el) {
        el.classList.toggle('expanded', state.thinkingExpanded);
      }
    }

    function copyMessage(btn) {
      const content = btn.closest('.message').querySelector('.content').textContent;
      navigator.clipboard.writeText(content);
    }

    function scrollToBottom() {
      messages.scrollTop = messages.scrollHeight;
    }

    function autoResize(textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function formatContent(text) {
      if (!text) return '';

      // Basic markdown-like formatting
      let html = escapeHtml(text);

      // Code blocks
      html = html.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>');

      // Inline code
      html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');

      // Bold
      html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');

      // Italic
      html = html.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');

      return html;
    }

    function formatTimestamp(date) {
      if (!date) return 'Now';
      const d = new Date(date);
      const now = new Date();
      const diffMs = now.getTime() - d.getTime();
      const diffMins = Math.floor(diffMs / 60000);

      if (diffMins < 1) return 'Now';
      if (diffMins < 60) return \`\${diffMins}m ago\`;

      const diffHours = Math.floor(diffMins / 60);
      if (diffHours < 24) return \`\${diffHours}h ago\`;

      return d.toLocaleDateString();
    }

    function formatRelativeTime(date) {
      if (!date) return '';
      const d = new Date(date);
      const now = new Date();
      const diffMs = now.getTime() - d.getTime();
      const diffMins = Math.floor(diffMs / 60000);

      if (diffMins < 1) return 'now';
      if (diffMins < 60) return \`\${diffMins}m\`;

      const diffHours = Math.floor(diffMins / 60);
      if (diffHours < 24) return \`\${diffHours}h\`;

      const diffDays = Math.floor(diffHours / 24);
      return \`\${diffDays}d\`;
    }

    function formatK(n) {
      if (n >= 1000) {
        return (n / 1000).toFixed(1) + 'K';
      }
      return String(n);
    }

    function groupChatsByDate(chats) {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const yesterday = new Date(today.getTime() - 86400000);

      return {
        today: chats.filter(c => new Date(c.createdAt) >= today),
        yesterday: chats.filter(c => {
          const d = new Date(c.createdAt);
          return d >= yesterday && d < today;
        }),
        older: chats.filter(c => new Date(c.createdAt) < yesterday)
      };
    }

    function showError(message) {
      const div = document.createElement('div');
      div.className = 'message assistant-message';
      div.innerHTML = \`<div class="content" style="color: var(--vscode-errorForeground);">Error: \${escapeHtml(message)}</div>\`;
      messages.appendChild(div);
      scrollToBottom();
    }
  </script>
</body>
</html>`;
  }
}

interface WebviewMessage {
  type: string;
  text?: string;
  id?: string;
  title?: string;
  model?: string;
  query?: string;
}
