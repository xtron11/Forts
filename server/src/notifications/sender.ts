import { GrammyError, type Api } from 'grammy';

export interface MessageButton {
  text: string;
  /** Адрес мини-приложения — кнопка web_app. */
  url: string;
}

export type SendResult =
  | { ok: true }
  /** 403: бот заблокирован (или чата нет) — писать больше нельзя. */
  | { ok: false; kind: 'blocked'; message: string }
  /** 429: Telegram просит подождать. */
  | { ok: false; kind: 'rate_limited'; retryAfterSec: number }
  /** Сеть, 5xx и прочее — можно повторить позже. */
  | { ok: false; kind: 'error'; message: string };

/** Отправка сообщения игроку; в тестах подменяется. */
export interface NotificationSender {
  send(chatId: number, text: string, button?: MessageButton): Promise<SendResult>;
}

export function telegramSender(api: Api): NotificationSender {
  return {
    async send(chatId, text, button) {
      try {
        await api.sendMessage(chatId, text, {
          reply_markup: button ? { inline_keyboard: [[{ text: button.text, web_app: { url: button.url } }]] } : undefined,
          link_preview_options: { is_disabled: true },
        });
        return { ok: true };
      } catch (err) {
        if (err instanceof GrammyError) {
          if (err.error_code === 429) return { ok: false, kind: 'rate_limited', retryAfterSec: err.parameters.retry_after ?? 5 };
          if (err.error_code === 403 || (err.error_code === 400 && /chat not found|user not found|deactivated/i.test(err.description))) {
            return { ok: false, kind: 'blocked', message: err.description };
          }
          return { ok: false, kind: 'error', message: err.description };
        }
        return { ok: false, kind: 'error', message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
