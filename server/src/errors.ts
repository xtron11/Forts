import type { FastifyReply } from 'fastify';
import type { ApiErrorCode, ApiErrorResponse } from '@forts/shared';

const STATUS: Record<ApiErrorCode, number> = {
  validation: 400,
  unknown_building_type: 400,
  unauthorized: 401,
  invalid_init_data: 401,
  init_data_expired: 401,
  not_found: 404,
  out_of_bounds: 422,
  overlap: 422,
  // Игровые правила: запрос корректен, но сейчас так нельзя.
  limit_reached: 422,
  townhall_level_too_low: 422,
  no_free_builder: 422,
  not_enough_resources: 422,
  under_construction: 422,
  max_level: 422,
  not_producer: 422,
  nothing_to_collect: 422,
  storage_full: 422,
  internal: 500,
};

/** Единый формат ошибки API; HTTP-статус выбирается по коду. */
export function sendError(reply: FastifyReply, error: ApiErrorCode, message: string): FastifyReply {
  const body: ApiErrorResponse = { error, message };
  return reply.code(STATUS[error]).send(body);
}
