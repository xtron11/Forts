import type { RuleCheck } from '@forts/shared';
import type { TextKey } from '../i18n';

export interface Message {
  key: TextKey;
  params?: Record<string, string | number>;
}

/** Почему нельзя построить/улучшить — по результату проверки из shared. */
export function ruleMessage(check: Extract<RuleCheck, { ok: false }>): Message {
  switch (check.reason) {
    case 'townhall_level_too_low':
      return { key: 'reason.townhall', params: { level: check.requiredTownhall ?? '?' } };
    case 'limit_reached':
      return check.requiredTownhall ? { key: 'reason.limitTownhall', params: { level: check.requiredTownhall } } : { key: 'reason.limit' };
    case 'no_free_builder':
      return { key: 'reason.builder' };
    case 'not_enough_resources':
      return { key: check.missing === 'food' ? 'reason.food' : 'reason.gold' };
    case 'under_construction':
      return { key: 'reason.busy' };
    case 'max_level':
      return { key: 'reason.maxLevel' };
    default:
      return { key: 'build.cannotPlace' };
  }
}

/** Текст по коду ошибки сервера или локальной проверки места. */
export function errorMessage(code: string): Message {
  switch (code) {
    case 'overlap':
      return { key: 'build.error.overlap' };
    case 'out_of_bounds':
      return { key: 'build.error.outOfBounds' };
    case 'limit_reached':
      return { key: 'reason.limit' };
    case 'townhall_level_too_low':
      return { key: 'reason.townhallAny' };
    case 'no_free_builder':
      return { key: 'reason.builder' };
    case 'not_enough_resources':
      return { key: 'reason.resources' };
    case 'under_construction':
      return { key: 'reason.busy' };
    case 'max_level':
      return { key: 'reason.maxLevel' };
    case 'storage_full':
      return { key: 'collect.storageFull' };
    case 'nothing_to_collect':
      return { key: 'collect.nothing' };
    case 'network':
      return { key: 'error.network' };
    default:
      return { key: 'build.cannotPlace' };
  }
}
