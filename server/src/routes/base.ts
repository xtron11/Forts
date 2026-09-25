import type { FastifyInstance } from 'fastify';
import {
  API_ROUTES,
  type ApiErrorResponse,
  type MeResponse,
  type PlaceBuildingRequest,
  type PlaceBuildingResponse,
} from '@forts/shared';
import type { Db } from '../db';
import { sendError } from '../errors';
import { loadBase, placeBuilding } from '../players';

/** Маршруты базы игрока; все требуют JWT. */
export async function baseRoutes(app: FastifyInstance, { db }: { db: Db }): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return sendError(reply, 'unauthorized', 'Missing or invalid token');
    }
  });

  const playerId = (sub: string) => Number(sub);

  app.get<{ Reply: MeResponse | ApiErrorResponse }>(API_ROUTES.me, async (request, reply) => {
    const base = await loadBase(db, playerId(request.user.sub));
    return base ?? sendError(reply, 'unauthorized', 'Player not found');
  });

  app.post<{ Body: PlaceBuildingRequest; Reply: PlaceBuildingResponse | ApiErrorResponse }>(
    API_ROUTES.buildings,
    {
      schema: {
        body: {
          type: 'object',
          required: ['type', 'x', 'y'],
          additionalProperties: false,
          properties: {
            // Существование типа и границы поля проверяет checkPlacement —
            // так клиент получает конкретный код ошибки, а не общий validation.
            type: { type: 'string', maxLength: 32 },
            x: { type: 'integer', minimum: -1000, maximum: 1000 },
            y: { type: 'integer', minimum: -1000, maximum: 1000 },
          },
        },
      },
    },
    async (request, reply) => {
      const { type, x, y } = request.body;
      const result = await placeBuilding(db, playerId(request.user.sub), type, x, y);
      if (result.ok) return reply.code(201).send({ building: result.building });
      if (result.reason === 'not_found') return sendError(reply, 'unauthorized', 'Player not found');
      return sendError(reply, result.reason, `Cannot place ${type} at (${x}, ${y}): ${result.reason}`);
    },
  );
}
