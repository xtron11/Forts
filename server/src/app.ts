import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import Fastify, { type FastifyInstance } from 'fastify';
import { webhookCallback, type Bot } from 'grammy';
import { WEBHOOK_PATH } from './bot/bot';
import type { Config } from './config';
import type { Db } from './db';
import { sendError } from './errors';
import { authRoutes } from './routes/auth';
import { baseRoutes } from './routes/base';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    /** sub — id игрока в нашей базе. */
    payload: { sub: string };
    user: { sub: string };
  }
}

export interface AppDeps {
  config: Config;
  db: Db;
  /** Текущее время, мс; тесты подставляют свои часы. */
  now?: () => number;
  /** Бот; в режиме webhook его обновления принимаются на WEBHOOK_PATH. */
  bot?: Bot;
}

export async function buildApp({ config, db, now = Date.now, bot }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.nodeEnv === 'test' ? false : { level: config.nodeEnv === 'production' ? 'info' : 'debug' },
    // Без приведения типов: {"x": "3"} — ошибка валидации, а не 3.
    ajv: { customOptions: { coerceTypes: false } },
    bodyLimit: 16 * 1024,
  });

  await app.register(cors, { origin: config.corsOrigins, methods: ['GET', 'POST'] });
  await app.register(jwt, { secret: config.jwtSecret, sign: { expiresIn: '24h' } });

  app.setErrorHandler((err: { statusCode?: number; validation?: unknown; message: string }, request, reply) => {
    if (err.validation) return sendError(reply, 'validation', err.message);
    const status = err.statusCode ?? 500;
    if (status < 500) {
      // Битый JSON, неверный Content-Type, слишком большое тело и т. п.
      return reply.code(status).send({ error: 'validation', message: err.message });
    }
    request.log.error(err);
    return sendError(reply, 'internal', 'Internal server error');
  });
  app.setNotFoundHandler((request, reply) => sendError(reply, 'not_found', `Route ${request.method} ${request.url} not found`));

  app.get('/health', async () => ({ ok: true }));
  await app.register(authRoutes, { config, db, now });
  await app.register(baseRoutes, { db, now });

  if (bot && config.botMode === 'webhook' && config.webhookSecret) {
    // grammY сверяет X-Telegram-Bot-Api-Secret-Token и отвечает 401 при несовпадении.
    const handle = webhookCallback(bot, 'fastify', { secretToken: config.webhookSecret, onTimeout: 'return', timeoutMilliseconds: 9000 });
    app.post(WEBHOOK_PATH, { bodyLimit: 1024 * 1024 }, handle);
  }

  return app;
}
