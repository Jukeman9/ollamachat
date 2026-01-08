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

export interface ChatsGroupedByDate {
  today: Chat[];
  yesterday: Chat[];
  older: Chat[];
}

interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  thinkingTime?: number;
  timestamp: string;
}

interface StoredChat {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  messages: StoredMessage[];
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

  setActive(id: string): void {
    if (this.chats.some(c => c.id === id)) {
      this.activeId = id;
    }
  }

  getAll(): Chat[] {
    return this.chats;
  }

  getById(id: string): Chat | undefined {
    return this.chats.find(c => c.id === id);
  }

  renameChat(id: string, title: string): void {
    const chat = this.chats.find(c => c.id === id);
    if (chat) {
      chat.title = title.trim() || 'New Chat';
      this.save();
    }
  }

  deleteChat(id: string): void {
    this.chats = this.chats.filter(c => c.id !== id);
    if (this.activeId === id) {
      this.activeId = this.chats[0]?.id || null;
    }
    this.save();
  }

  addMessage(chatId: string, msg: Message): void {
    const chat = this.chats.find(c => c.id === chatId);
    if (chat) {
      chat.messages.push(msg);
      // Auto-generate title from first user message
      if (chat.messages.length === 1 && msg.role === 'user') {
        const content = msg.content.trim();
        chat.title = content.slice(0, 40) + (content.length > 40 ? '...' : '');
      }
      this.save();
    }
  }

  updateContext(chatId: string, used: number, total: number): void {
    const chat = this.chats.find(c => c.id === chatId);
    if (chat) {
      chat.contextUsed = used;
      chat.contextTotal = total;
      this.save();
    }
  }

  updateModel(chatId: string, model: string): void {
    const chat = this.chats.find(c => c.id === chatId);
    if (chat) {
      chat.model = model;
      this.save();
    }
  }

  searchChats(query: string): Chat[] {
    const q = query.toLowerCase().trim();
    if (!q) return this.chats;

    return this.chats.filter(c =>
      c.title.toLowerCase().includes(q) ||
      c.messages.some(m => m.content.toLowerCase().includes(q))
    );
  }

  getChatsGroupedByDate(): ChatsGroupedByDate {
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

  private load(): void {
    const data = this.context.globalState.get<StoredChat[]>('ollama-chats', []);
    this.chats = data.map(c => ({
      ...c,
      createdAt: new Date(c.createdAt),
      messages: c.messages.map(m => ({
        ...m,
        timestamp: new Date(m.timestamp)
      }))
    }));
    this.activeId = this.chats[0]?.id || null;
  }

  private save(): void {
    this.context.globalState.update('ollama-chats', this.chats);
  }

  clearAllChats(): void {
    this.chats = [];
    this.activeId = null;
    this.save();
  }
}
