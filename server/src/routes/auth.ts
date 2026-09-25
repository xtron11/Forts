import type { FastifyInstance, FastifyReply } from 'fastify';
import { API_ROUTES, START_PARAM_PATTERN, type ApiErrorResponse, type AuthDevRequest, type AuthResponse, type AuthTelegramRequest } from '@forts/shared';
import type { Config } from '../config';
import type { Db } from '../db';
import { sendError } from '../errors';
import { loginPlayer, type LoginProfile } from '../players';
import { validateInitData, type TelegramInitUser } from '../telegram/initData';

const TOKEN_TTL_SECONDS = 24 * 60 * 60;
const NAME_MAX = 64;
const START_PARAM_RE = new RegExp(START_PARAM_PATTERN);

/** Необязательные поля входа, общие для Telegram и тестового игрока. */
const EXTRAS_SCHEMA = {
  timezone: { type: 'string', minLength: 1, maxLength: 64 },
  startParam: { type: 'string', pattern: START_PARAM_PATTERN },
} as const;

function displayName(user: TelegramInitUser): string {
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return (full || user.username || 'Player').slice(0, NAME_MAX);
}

async function issueToken(reply: FastifyReply, db: Db, profile: LoginProfile, now: number): Promise<AuthResponse> {
  const playerId = await loginPlayer(db, profile, now);
  const token = await reply.jwtSign({ sub: String(playerId) }, { expiresIn: TOKEN_TTL_SECONDS });
  return { token, expiresIn: TOKEN_TTL_SECONDS };
}

export async function authRoutes(app: FastifyInstance, { config, db, now }: { config: Config; db: Db; now: () => number }): Promise<void> {
  app.post<{ Body: AuthTelegramRequest; Reply: AuthResponse | ApiErrorResponse }>(
    API_ROUTES.authTelegram,
    {
      schema: {
        body: {
          type: 'object',
          required: ['initData'],
          additionalProperties: false,
          properties: { initData: { type: 'string', minLength: 1, maxLength: 4096 }, ...EXTRAS_SCHEMA },
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
      // Подписанный start_param важнее присланного клиентом (из адреса кнопки).
      const signed = result.startParam && START_PARAM_RE.test(result.startParam) ? result.startParam : undefined;
      return issueToken(
        reply,
        db,
        {
          telegramId: user.id,
          name: displayName(user),
          languageCode: (user.language_code ?? 'en').slice(0, 16),
          allowsWriteToPm: user.allows_write_to_pm === true,
          timezone: request.body.timezone,
          startParam: signed ?? request.body.startParam,
        },
        now(),
      );
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
              telegramId: { type: 'integer', minimum: 1, maximum: 9_007_199_254_740_991 },
              ...EXTRAS_SCHEMA,
            },
          },
        },
      },
      async (request, reply) => {
        const { devId, name, languageCode, telegramId, timezone, startParam } = request.body;
        // Отрицательный telegram_id — тестовые игроки не пересекаются с настоящими.
        // telegramId — войти настоящим игроком, чтобы проверять уведомления бота из браузера.
        return issueToken(reply, db, { telegramId: telegramId ?? -devId, name, languageCode, timezone, startParam }, now());
      },
    );
  }
}
