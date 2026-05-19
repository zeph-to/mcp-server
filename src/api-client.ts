import type { McpServerConfig } from './config.js';
import type {
  ApiErrorBody,
  PushResponse,
  HookTriggerResponse,
  HookEventResponse,
  DevicesResponse,
  PushListResponse,
  DismissResponse,
  ChannelsResponse,
  UploadRequestResponse,
} from './types.js';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 15_000;

export class ZephApiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: McpServerConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
  }

  async sendPush(params: {
    title?: string;
    body?: string;
    url?: string;
    type?: string;
    priority?: string;
    targetDeviceId?: string;
    channelId?: string;
    files?: { fileKey: string; fileName: string; fileSize: number; fileType: string; iv?: string; encryptedKey?: string }[];
    isEncrypted?: boolean;
    encryptedKey?: string;
    senderPublicKey?: string;
  }): Promise<PushResponse> {
    return this.request<PushResponse>('POST', '/pushes/send', params);
  }

  async triggerHook(
    hookId: string,
    params: {
      title: string;
      body?: string;
      actions?: { id: string; label: string }[];
      timeout?: number;
      fallback?: string;
      metadata?: Record<string, unknown>;
      hookType?: 'one-way' | 'interactive' | 'input' | 'combo';
      files?: { fileKey: string; fileName: string; fileSize: number; fileType: string; iv?: string; encryptedKey?: string }[];
    },
  ): Promise<HookTriggerResponse> {
    return this.request<HookTriggerResponse>('POST', `/hooks/${hookId}/trigger`, params);
  }

  async getHookEvent(hookId: string, eventId: string): Promise<HookEventResponse> {
    return this.request<HookEventResponse>('GET', `/hooks/${hookId}/events/${eventId}`, undefined, POLL_TIMEOUT_MS);
  }

  async listDevices(): Promise<DevicesResponse> {
    return this.request<DevicesResponse>('GET', '/devices');
  }

  async listPushes(params?: { limit?: number; type?: string }): Promise<PushListResponse> {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.type) query.set('type', params.type);
    const qs = query.toString();
    return this.request<PushListResponse>('GET', `/pushes${qs ? `?${qs}` : ''}`);
  }

  async dismissPush(pushId: string): Promise<DismissResponse> {
    return this.request<DismissResponse>('POST', `/pushes/${encodeURIComponent(pushId)}/dismiss`);
  }

  async dismissAllPushes(): Promise<DismissResponse> {
    return this.request<DismissResponse>('POST', '/pushes/dismiss-all');
  }

  async listChannels(): Promise<ChannelsResponse> {
    return this.request<ChannelsResponse>('GET', '/channels');
  }

  async requestUpload(params: {
    fileName: string;
    fileType: string;
    fileSize: number;
  }): Promise<UploadRequestResponse> {
    return this.request<UploadRequestResponse>('POST', '/files/upload-request', params);
  }

  async uploadToS3(url: string, content: string | Buffer, contentType: string): Promise<void> {
    const isText = typeof content === 'string';
    const body = isText ? content : new Uint8Array(content);
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': isText ? `${contentType}; charset=utf-8` : contentType },
      body,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new ApiError(`S3 upload failed with status ${response.status}`, 'UPLOAD_FAILED', response.status);
    }
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new ApiError('Request timed out', 'TIMEOUT', 408);
      }
      throw err;
    }

    if (!response.ok) {
      let errorBody: ApiErrorBody | null = null;
      try {
        errorBody = (await response.json()) as ApiErrorBody;
      } catch {
        // Non-JSON error response (e.g., HTML error page)
      }
      const message = errorBody?.error?.message ?? `Request failed with status ${response.status}`;
      const code = errorBody?.error?.code ?? 'UNKNOWN_ERROR';
      throw new ApiError(message, code, response.status);
    }

    return (await response.json()) as T;
  }
}
