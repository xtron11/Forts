import {
  API_ROUTES,
  type ApiErrorCode,
  type ApiErrorResponse,
  type AuthResponse,
  type LoginCredentials,
  type MeResponse,
  type PlaceBuildingRequest,
  type PlaceBuildingResponse,
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
 */
export class ApiClient {
  private token: string | null = null;

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

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    let res: Response;
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
    if (res.ok) return data as T;
    const error = data as Partial<ApiErrorResponse> | undefined;
    throw new ApiError(error?.error ?? 'internal', error?.message ?? `HTTP ${res.status}`);
  }
}
