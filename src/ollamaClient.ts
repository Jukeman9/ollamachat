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

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface OllamaTagsResponse {
  models?: Array<{ name: string; details?: { family?: string } }>;
}

interface OllamaPsResponse {
  models?: Array<{ model: string }>;
}

interface OllamaShowResponse {
  model_info?: { 'llama.context_length'?: number; context_length?: number };
  details?: { family?: string };
}

export class OllamaClient {
  private baseUrl = 'http://localhost:11434';

  async listModels(): Promise<Model[]> {
    const [tagsRes, psRes] = await Promise.all([
      fetch(`${this.baseUrl}/api/tags`),
      fetch(`${this.baseUrl}/api/ps`)
    ]);

    const tags = await tagsRes.json() as OllamaTagsResponse;
    const ps = await psRes.json() as OllamaPsResponse;

    const loadedModels = ps.models || [];
    const loadedSet = new Set(loadedModels.map((m) => m.model));

    // Model families known to support thinking/reasoning
    const thinkingFamilies = ['deepseek', 'qwen', 'qwq'];

    return (tags.models || []).map((m) => ({
      name: m.name,
      loaded: loadedSet.has(m.name),
      contextLength: 4096, // Default, can be updated via getModelInfo
      supportsThinking: thinkingFamilies.some(f =>
        m.name.toLowerCase().includes(f) ||
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
    const data = await res.json() as OllamaShowResponse;

    // Extract context length from model info
    const contextLength = data.model_info?.['llama.context_length'] ||
                         data.model_info?.context_length ||
                         4096;

    return {
      contextLength,
      family: data.details?.family || ''
    };
  }

  async *chatStream(
    model: string,
    messages: ChatMessage[],
    think = true
  ): AsyncGenerator<ChatChunk> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        options: think ? { think: true } : undefined
      })
    });

    if (!res.ok) {
      throw new Error(`Ollama API error: ${res.status} ${res.statusText}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          yield {
            content: chunk.message?.content || '',
            thinking: chunk.message?.thinking || '',
            done: chunk.done || false,
            promptTokens: chunk.prompt_eval_count,
            evalTokens: chunk.eval_count
          };
        } catch {
          // Skip malformed JSON lines
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      try {
        const chunk = JSON.parse(buffer);
        yield {
          content: chunk.message?.content || '',
          thinking: chunk.message?.thinking || '',
          done: chunk.done || false,
          promptTokens: chunk.prompt_eval_count,
          evalTokens: chunk.eval_count
        };
      } catch {
        // Skip malformed JSON
      }
    }
  }

  async chat(
    model: string,
    messages: ChatMessage[],
    think = true
  ): Promise<{ content: string; thinking: string; promptTokens: number; evalTokens: number }> {
    let content = '';
    let thinking = '';
    let promptTokens = 0;
    let evalTokens = 0;

    for await (const chunk of this.chatStream(model, messages, think)) {
      content += chunk.content;
      thinking += chunk.thinking;
      if (chunk.promptTokens) promptTokens = chunk.promptTokens;
      if (chunk.evalTokens) evalTokens = chunk.evalTokens;
    }

    return { content, thinking, promptTokens, evalTokens };
  }
}
