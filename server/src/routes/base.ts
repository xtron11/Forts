import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  API_ROUTES,
  MAX_TRAIN_BATCH,
  type ApiErrorResponse,
  type CancelTrainingResponse,
  type CollectResponse,
  type MeResponse,
  type MoveBuildingRequest,
  type MoveBuildingResponse,
  type PlaceBuildingRequest,
  type PlaceBuildingResponse,
  type TrainTroopsRequest,
  type TrainTroopsResponse,
  type UpgradeBuildingResponse,
  type WriteAccessRequest,
  type WriteAccessResponse,
} from '@forts/shared';
import type { Db } from '../db';
import { sendError } from '../errors';
import {
  cancelTrainingItem,
  collectBuilding,
  isFailure,
  loadBase,
  moveBuilding,
  placeBuilding,
  setWriteAccess,
  trainTroops,
  upgradeBuilding,
  type Failure,
} from '../game';

// Существование типа и границы поля проверяет checkPlacement — так клиент
// получает конкретный код ошибки, а не общий validation.
const COORD = { type: 'integer', minimum: -1000, maximum: 1000 } as const;

// Без приведения типов параметры пути — строки, поэтому id проверяем шаблоном.
const ID_PARAMS = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: '^[1-9][0-9]{0,14}$' } },
} as const;

type IdParams = { id: string };

function send<T extends object>(reply: FastifyReply, result: T | Failure, code = 200) {
  return isFailure(result) ? sendError(reply, result.error, result.message) : reply.code(code).send(result);
}

/** Маршруты базы игрока; все требуют JWT. */
export async function baseRoutes(app: FastifyInstance, { db, now }: { db: Db; now: () => number }): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return sendError(reply, 'unauthorized', 'Missing or invalid token');
    }
  });

  const playerId = (sub: string) => Number(sub);

  app.get<{ Reply: MeResponse | ApiErrorResponse }>(API_ROUTES.me, async (request, reply) =>
    send(reply, await loadBase(db, playerId(request.user.sub), now())),
  );

  app.post<{ Body: PlaceBuildingRequest; Reply: PlaceBuildingResponse | ApiErrorResponse }>(
    API_ROUTES.buildings,
    {
      schema: {
        body: {
          type: 'object',
          required: ['type', 'x', 'y'],
          additionalProperties: false,
          properties: { type: { type: 'string', maxLength: 32 }, x: COORD, y: COORD },
        },
      },
    },
    async (request, reply) => {
      const { type, x, y } = request.body;
      return send(reply, await placeBuilding(db, playerId(request.user.sub), type, x, y, now()), 201);
    },
  );

  app.post<{ Params: IdParams; Reply: UpgradeBuildingResponse | ApiErrorResponse }>(
    API_ROUTES.upgradeBuilding,
    { schema: { params: ID_PARAMS } },
    async (request, reply) => send(reply, await upgradeBuilding(db, playerId(request.user.sub), Number(request.params.id), now())),
  );

  app.post<{ Params: IdParams; Reply: CollectResponse | ApiErrorResponse }>(
    API_ROUTES.collectBuilding,
    { schema: { params: ID_PARAMS } },
    async (request, reply) => send(reply, await collectBuilding(db, playerId(request.user.sub), Number(request.params.id), now())),
  );

  app.post<{ Params: IdParams; Body: MoveBuildingRequest; Reply: MoveBuildingResponse | ApiErrorResponse }>(
    API_ROUTES.moveBuilding,
    {
      schema: {
        params: ID_PARAMS,
        body: { type: 'object', required: ['x', 'y'], additionalProperties: false, properties: { x: COORD, y: COORD } },
      },
    },
    async (request, reply) => {
      const { x, y } = request.body;
      return send(reply, await moveBuilding(db, playerId(request.user.sub), Number(request.params.id), x, y, now()));
    },
  );

  app.post<{ Body: WriteAccessRequest; Reply: WriteAccessResponse | ApiErrorResponse }>(
    API_ROUTES.writeAccess,
    {
      schema: {
        body: { type: 'object', required: ['granted'], additionalProperties: false, properties: { granted: { type: 'boolean' } } },
      },
    },
    async (request, reply) => send(reply, await setWriteAccess(db, playerId(request.user.sub), request.body.granted, now())),
  );

  app.post<{ Body: TrainTroopsRequest; Reply: TrainTroopsResponse | ApiErrorResponse }>(
    API_ROUTES.trainTroops,
    {
      schema: {
        body: {
          type: 'object',
          required: ['troop', 'count'],
          additionalProperties: false,
          // Существование войска проверяет checkTrain — клиент получает код unknown_troop.
          properties: { troop: { type: 'string', maxLength: 32 }, count: { type: 'integer', minimum: 1, maximum: MAX_TRAIN_BATCH } },
        },
      },
    },
    async (request, reply) => {
      const { troop, count } = request.body;
      return send(reply, await trainTroops(db, playerId(request.user.sub), troop, count, now()));
    },
  );

  app.post<{ Params: IdParams; Reply: CancelTrainingResponse | ApiErrorResponse }>(
    API_ROUTES.cancelTraining,
    { schema: { params: ID_PARAMS } },
    async (request, reply) => send(reply, await cancelTrainingItem(db, playerId(request.user.sub), Number(request.params.id), now())),
  );
}
