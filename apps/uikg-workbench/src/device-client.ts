import type {
  PlaygroundRuntimeInfo,
  PlaygroundSessionState,
  PlaygroundSessionTarget,
} from '@midscene/playground';

export interface DeviceInterfaceInfo {
  type: string;
  description?: string;
  size?: { width: number; height: number };
  navigationState?: { isLoading: boolean };
  actionTypes?: string[];
}

export type InteractPayload = { actionType: string } & Record<string, unknown>;

async function responseBody<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `设备服务请求失败：${response.status}`);
  }
  return body as T;
}

export class DeviceClient {
  constructor(private readonly serverUrl: string) {}

  async checkStatus(): Promise<boolean> {
    try {
      return (await fetch(`${this.serverUrl}/status`)).ok;
    } catch {
      return false;
    }
  }

  async getSessionInfo(): Promise<PlaygroundSessionState | null> {
    return responseBody(await fetch(`${this.serverUrl}/session`));
  }

  async listSessionTargets(forceRefresh = false): Promise<PlaygroundSessionTarget[]> {
    const suffix = forceRefresh ? '?refresh=1' : '';
    const result = await responseBody<unknown>(await fetch(`${this.serverUrl}/session/targets${suffix}`));
    return Array.isArray(result) ? result as PlaygroundSessionTarget[] : [];
  }

  async getRuntimeInfo(): Promise<PlaygroundRuntimeInfo | null> {
    return responseBody(await fetch(`${this.serverUrl}/runtime-info`));
  }

  async getInterfaceInfo(): Promise<DeviceInterfaceInfo | null> {
    try {
      return await responseBody(await fetch(`${this.serverUrl}/interface-info`));
    } catch {
      return null;
    }
  }

  async createSession(deviceId: string): Promise<{
    session: PlaygroundSessionState;
    runtimeInfo: PlaygroundRuntimeInfo;
  }> {
    return responseBody(await fetch(`${this.serverUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    }));
  }

  async destroySession(): Promise<{
    session: PlaygroundSessionState;
    runtimeInfo: PlaygroundRuntimeInfo;
  }> {
    return responseBody(await fetch(`${this.serverUrl}/session`, { method: 'DELETE' }));
  }

  async interact(payload: InteractPayload): Promise<void> {
    await responseBody(await fetch(`${this.serverUrl}/interact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }));
  }

  async tap(x: number, y: number): Promise<void> {
    await responseBody(await fetch(`${this.serverUrl}/workbench/api/device/tap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x, y }),
    }));
  }
}
