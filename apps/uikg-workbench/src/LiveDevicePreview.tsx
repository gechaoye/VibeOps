import type { PlaygroundRuntimeInfo } from '@midscene/playground';
import { DeviceInteractionLayer } from './device-preview/DeviceInteractionLayer';
import { ScrcpyPanel } from './device-preview/ScrcpyPanel';
import { LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DeviceClient, DeviceInterfaceInfo, InteractPayload } from './device-client';

interface LiveDevicePreviewProps {
  client: DeviceClient;
  runtimeInfo: PlaygroundRuntimeInfo;
  serverUrl: string;
  enabled: boolean;
  onError: (message: string) => void;
}

interface Point { x: number; y: number }

function scrcpyConnection(runtimeInfo: PlaygroundRuntimeInfo, serverUrl: string) {
  const port = Number(runtimeInfo.preview.custom?.scrcpyPort);
  if (runtimeInfo.preview.kind !== 'scrcpy' || !Number.isFinite(port)) return null;
  const url = new URL(serverUrl);
  url.port = String(port);
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  const deviceId = typeof runtimeInfo.metadata.deviceId === 'string'
    ? runtimeInfo.metadata.deviceId
    : undefined;
  return { serverUrl: url.toString(), deviceId };
}

function scrollPayload(point: Point, delta: { deltaX: number; deltaY: number }, deviceSize: { width: number; height: number }): InteractPayload {
  const vertical = Math.abs(delta.deltaY) >= Math.abs(delta.deltaX);
  const rawDistance = vertical ? Math.abs(delta.deltaY) : Math.abs(delta.deltaX);
  const limit = (vertical ? deviceSize.height : deviceSize.width) * 0.55;
  const distance = Math.min(limit, Math.max(72, rawDistance * 2.2));
  const end = vertical
    ? { x: point.x, y: point.y + (delta.deltaY >= 0 ? -distance : distance) }
    : { x: point.x + (delta.deltaX >= 0 ? -distance : distance), y: point.y };
  return {
    actionType: 'Swipe',
    x: point.x,
    y: point.y,
    endX: Math.round(Math.min(Math.max(end.x, 0), deviceSize.width - 1)),
    endY: Math.round(Math.min(Math.max(end.y, 0), deviceSize.height - 1)),
    duration: 180,
  };
}

export function LiveDevicePreview({ client, runtimeInfo, serverUrl, enabled, onError }: LiveDevicePreviewProps) {
  const connection = useMemo(() => scrcpyConnection(runtimeInfo, serverUrl), [runtimeInfo, serverUrl]);
  const contentRef = useRef<HTMLDivElement>(null);
  const queueRef = useRef(Promise.resolve());
  const textRef = useRef('');
  const textPointRef = useRef<Point>();
  const textTimerRef = useRef<number>();
  const [interfaceInfo, setInterfaceInfo] = useState<DeviceInterfaceInfo | null>(null);
  const [intrinsicSize, setIntrinsicSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const result = await client.getInterfaceInfo();
      if (active && result) setInterfaceInfo(result);
    };
    void refresh();
    return () => {
      active = false;
    };
  }, [client, runtimeInfo]);

  const send = useCallback((payload: InteractPayload) => {
    queueRef.current = queueRef.current
      .catch(() => undefined)
      .then(() => client.interact(payload))
      .catch((error) => onError(error instanceof Error ? error.message : String(error)));
    return queueRef.current;
  }, [client, onError]);

  const sendTap = useCallback((point: Point) => {
    queueRef.current = queueRef.current
      .catch(() => undefined)
      .then(() => client.tap(point.x, point.y))
      .catch((error) => onError(error instanceof Error ? error.message : String(error)));
    return queueRef.current;
  }, [client, onError]);

  const flushText = useCallback(async () => {
    if (textTimerRef.current) window.clearTimeout(textTimerRef.current);
    textTimerRef.current = undefined;
    const value = textRef.current;
    const point = textPointRef.current;
    textRef.current = '';
    textPointRef.current = undefined;
    if (!value) return;
    await send({ actionType: 'Input', value, mode: 'typeOnly', ...(point || {}) });
  }, [send]);

  useEffect(() => () => {
    if (textTimerRef.current) window.clearTimeout(textTimerRef.current);
  }, []);

  const beforeDiscreteAction = useCallback(async (payload: InteractPayload) => {
    await flushText();
    await send(payload);
  }, [flushText, send]);

  const deviceSize = interfaceInfo?.size || intrinsicSize || null;
  const actions = interfaceInfo?.actionTypes || [];
  const supports = (name: string) => actions.length === 0 || actions.includes(name);

  if (!connection) {
    return <div className="live-preview-state"><TriangleAlert size={28} /><strong>当前会话没有实时画面</strong></div>;
  }

  return (
    <div className="live-device-preview" style={deviceSize ? { aspectRatio: `${deviceSize.width} / ${deviceSize.height}` } : undefined}>
      <ScrcpyPanel
        deviceId={connection.deviceId}
        serverUrl={connection.serverUrl}
        contentRef={contentRef}
        onIntrinsicSize={setIntrinsicSize}
        connectingOverlay={<div className="live-preview-state"><LoaderCircle className="spin" size={24} /><strong>正在连接设备画面</strong></div>}
        renderErrorOverlay={({ errorMessage, retry }) => (
          <div className="live-preview-state">
            <TriangleAlert size={27} />
            <strong>设备画面连接失败</strong>
            {errorMessage && <span>{errorMessage}</span>}
            <button type="button" className="button" onClick={retry}><RefreshCw size={14} />重新连接</button>
          </div>
        )}
        viewportStyle={{ width: '100%', height: '100%', borderRadius: 0, background: '#111814' }}
      />
      <DeviceInteractionLayer
        enabled={enabled && Boolean(deviceSize)}
        deviceSize={deviceSize}
        contentRef={contentRef}
        onTap={async (point) => {
          await flushText();
          await sendTap(point);
        }}
        onSwipe={(start, end, duration) => { void beforeDiscreteAction({ actionType: 'Swipe', x: start.x, y: start.y, endX: end.x, endY: end.y, duration: Math.min(450, Math.max(120, duration)) }); }}
        scrollEnabled={supports('Scroll')}
        onWheelScroll={(point, delta) => { if (deviceSize) void beforeDiscreteAction(scrollPayload(point, delta, deviceSize)); }}
        keyboardEnabled={supports('Input') || supports('KeyboardPress')}
        onTextInput={(text, point) => {
          textRef.current += text;
          if (point) textPointRef.current = point;
          if (textTimerRef.current) window.clearTimeout(textTimerRef.current);
          textTimerRef.current = window.setTimeout(() => void flushText(), 80);
        }}
        onKeyboardPress={(keyName) => { void beforeDiscreteAction({ actionType: 'KeyboardPress', keyName }); }}
        style={{ position: 'absolute', inset: 0 }}
      />
    </div>
  );
}
