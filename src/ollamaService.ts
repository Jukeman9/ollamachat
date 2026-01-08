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
      try {
        await this.startServer();
        vscode.window.showInformationMessage('Ollama started successfully!');
        return true;
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to start Ollama: ${error}`);
        return false;
      }
    }
    return false;
  }
}
