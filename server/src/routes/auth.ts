import type { FastifyInstance, FastifyReply } from 'fastify';
import { API_ROUTES, type ApiErrorResponse, type AuthDevRequest, type AuthResponse, type AuthTelegramRequest } from '@forts/shared';
import type { Config } from '../config';
import type { Db } from '../db';
import { sendError } from '../errors';
import { loginPlayer, type LoginProfile } from '../players';
import { validateInitData, type TelegramInitUser } from '../telegram/initData';

const TOKEN_TTL_SECONDS = 24 * 60 * 60;
const NAME_MAX = 64;

function displayName(user: TelegramInitUser): string {
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return (full || user.username || 'Player').slice(0, NAME_MAX);
}

async function issueToken(reply: FastifyReply, db: Db, profile: LoginProfile): Promise<AuthResponse> {
  const playerId = await loginPlayer(db, profile);
  const token = await reply.jwtSign({ sub: String(playerId) }, { expiresIn: TOKEN_TTL_SECONDS });
  return { token, expiresIn: TOKEN_TTL_SECONDS };
}

export async function authRoutes(app: FastifyInstance, { config, db }: { config: Config; db: Db }): Promise<void> {
  app.post<{ Body: AuthTelegramRequest; Reply: AuthResponse | ApiErrorResponse }>(
    API_ROUTES.authTelegram,
    {
      schema: {
        body: {
          type: 'object',
          required: ['initData'],
          additionalProperties: false,
          properties: { initData: { type: 'string', minLength: 1, maxLength: 4096 } },
        },
      },
    },
    async (request, reply) => {
      const result = validateInitData(request.body.initData, config.botToken);
      if (!result.ok) {
        request.log.info({ reason: result.reason }, 'initData rejected');
        return result.reason === 'expired'
          ? sendError(reply, 'init_data_expired', 'initData is older than 24 hours')
          : sendError(reply, 'invalid_init_data', 'initData signature is invalid');
      }
      const { user } = result;
      return issueToken(reply, db, {
        telegramId: user.id,
        name: displayName(user),
        languageCode: (user.language_code ?? 'en').slice(0, 16),
      });
    },
  );

  // Вход без Telegram существует только в режиме разработки: в остальных
  // режимах маршрут не регистрируется и отвечает 404.
  if (config.nodeEnv === 'development') {
    app.log.warn(`dev login enabled at POST ${API_ROUTES.authDev}`);
    app.post<{ Body: AuthDevRequest; Reply: AuthResponse }>(
      API_ROUTES.authDev,
      {
        schema: {
          body: {
            type: 'object',
            required: ['devId', 'name', 'languageCode'],
            additionalProperties: false,
            properties: {
              devId: { type: 'integer', minimum: 1, maximum: 1_000_000_000 },
              name: { type: 'string', minLength: 1, maxLength: NAME_MAX },
              languageCode: { type: 'string', minLength: 1, maxLength: 16 },
            },
          },
        },
      },
      async (request, reply) => {
        const { devId, name, languageCode } = request.body;
        // Отрицательный telegram_id — тестовые игроки не пересекаются с настоящими.
        return issueToken(reply, db, { telegramId: -devId, name, languageCode });
      },
    );
  }
}
