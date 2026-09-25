import {
  API_ROUTES,
  buildingPath,
  type ApiErrorCode,
  type ApiErrorResponse,
  type AuthResponse,
  type CollectResponse,
  type LoginCredentials,
  type MeResponse,
  type MoveBuildingRequest,
  type MoveBuildingResponse,
  type PlaceBuildingRequest,
  type PlaceBuildingResponse,
  type UpgradeBuildingResponse,
} from '@forts/shared';

const TIMEOUT_MS = 10_000;

/** Ошибка запроса: код от сервера или 'network', если ответа нет. */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode | 'network',
    message: string,
  ) {
    super(message);
  }
}

/**
 * HTTP-клиент игрового API. Токен хранится только в памяти: после
 * перезагрузки страницы клиент заново входит через платформу.
 *
 * Заодно следит за разницей часов: ответы с serverTime сдвигают оценку
 * времени сервера (serverNow), по которой клиент считает таймеры и добычу.
 */
export class ApiClient {
  private token: string | null = null;
  /** serverTime − локальное время; берётся из ответа с самым коротким запросом. */
  private clockOffset = 0;
  private clockRtt = Infinity;
  private clockMeasuredAt = 0;

  constructor(private readonly baseUrl: string) {}

  async login(credentials: LoginCredentials): Promise<void> {
    const { kind, ...body } = credentials;
    const route = kind === 'telegram' ? API_ROUTES.authTelegram : API_ROUTES.authDev;
    const res = await this.request<AuthResponse>('POST', route, body);
    this.token = res.token;
  }

  getMe(): Promise<MeResponse> {
    return this.request('GET', API_ROUTES.me);
  }

  placeBuilding(body: PlaceBuildingRequest): Promise<PlaceBuildingResponse> {
    return this.request('POST', API_ROUTES.buildings, body);
  }

  upgradeBuilding(id: number): Promise<UpgradeBuildingResponse> {
    return this.request('POST', buildingPath(API_ROUTES.upgradeBuilding, id));
  }

  collect(id: number): Promise<CollectResponse> {
    return this.request('POST', buildingPath(API_ROUTES.collectBuilding, id));
  }

  moveBuilding(id: number, body: MoveBuildingRequest): Promise<MoveBuildingResponse> {
    return this.request('POST', buildingPath(API_ROUTES.moveBuilding, id), body);
  }

  /** Оценка текущего времени сервера, мс. */
  serverNow(): number {
    return Date.now() + this.clockOffset;
  }

  /**
   * Сервер посчитал ответ где-то между отправкой и получением; берём середину.
   * Предпочитаем быстрые запросы (точнее), но раз в минуту принимаем любой —
   * часы устройства могли перевести.
   */
  private updateClock(serverTime: number, sentAt: number, receivedAt: number): void {
    const rtt = receivedAt - sentAt;
    if (rtt > this.clockRtt && receivedAt - this.clockMeasuredAt < 60_000) return;
    this.clockOffset = serverTime - (sentAt + receivedAt) / 2;
    this.clockRtt = rtt;
    this.clockMeasuredAt = receivedAt;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    let res: Response;
    const sentAt = Date.now();
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new ApiError('network', err instanceof Error ? err.message : String(err));
    }

    const data: unknown = await res.json().catch(() => undefined);
    if (res.ok) {
      const serverTime = (data as { serverTime?: unknown } | undefined)?.serverTime;
      if (typeof serverTime === 'number') this.updateClock(serverTime, sentAt, Date.now());
      return data as T;
    }
    const error = data as Partial<ApiErrorResponse> | undefined;
    throw new ApiError(error?.error ?? 'internal', error?.message ?? `HTTP ${res.status}`);
  }
}
