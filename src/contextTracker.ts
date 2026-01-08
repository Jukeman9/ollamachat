export interface ContextUsage {
  percent: number;
  used: number;
  total: number;
}

export class ContextTracker {
  private tokenCounts = new Map<string, { used: number; total: number }>();

  update(chatId: string, promptTokens: number, evalTokens: number, total: number): void {
    this.tokenCounts.set(chatId, {
      used: promptTokens + evalTokens,
      total
    });
  }

  getUsage(chatId: string): ContextUsage {
    const data = this.tokenCounts.get(chatId);
    if (!data) {
      return { percent: 0, used: 0, total: 4096 };
    }
    const { used, total } = data;
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
    if (n >= 1000) {
      return `${(n / 1000).toFixed(1)}K`;
    }
    return String(n);
  }

  reset(chatId: string): void {
    this.tokenCounts.delete(chatId);
  }

  setTotal(chatId: string, total: number): void {
    const existing = this.tokenCounts.get(chatId);
    if (existing) {
      existing.total = total;
    } else {
      this.tokenCounts.set(chatId, { used: 0, total });
    }
  }
}
