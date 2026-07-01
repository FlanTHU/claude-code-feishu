import * as fs from 'fs';
import * as path from 'path';

// bot 对谈模式的独立持久化：仅按 chatId 记录，脱离会话生命周期。
// 之前把该标志存在 ChatSessionData 里，会话因重启/重绑被整条替换时标志一并丢失
// （实测：bridge 重启后群会话重建，/botmode on 状态消失）。故单独落一个文件的 chatId 集合。
const STORE_FILE = path.resolve(process.cwd(), '.bot-dialog-mode.json');

class BotDialogModeStore {
  private enabled = new Set<string>();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(STORE_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
        if (Array.isArray(parsed)) {
          this.enabled = new Set(parsed.filter((x): x is string => typeof x === 'string'));
        }
      }
    } catch (error) {
      console.error('[BotDialogModeStore] Load failed:', error);
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(STORE_FILE, JSON.stringify([...this.enabled], null, 2));
    } catch (error) {
      console.error('[BotDialogModeStore] Save failed:', error);
    }
  }

  isEnabled(chatId: string): boolean {
    return this.enabled.has(chatId);
  }

  set(chatId: string, enabled: boolean): void {
    if (enabled) {
      this.enabled.add(chatId);
    } else {
      this.enabled.delete(chatId);
    }
    this.save();
  }
}

export const botDialogModeStore = new BotDialogModeStore();
