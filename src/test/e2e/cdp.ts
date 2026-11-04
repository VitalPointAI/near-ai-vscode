// Stub for the RED step of Phase 62 plan 16 task 3: every helper does nothing, so the tests fail on their own assertions.
// The DevTools Protocol client arrives in the GREEN commit.
export interface Point { x: number; y: number }
export interface SocketLike { readyState?: number; send(data: string): void; close(): void; addEventListener(type: string, listener: (event: any) => void): void }
export interface CdpSession { send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>; on(event: string, listener: (params: any) => void): () => void; close(): void }
type Target = { type: string; url: string; webSocketDebuggerUrl?: string };
export function workbenchTarget(_targets: Target[]): { webSocketDebuggerUrl: string } | undefined { return undefined; }
export async function connectCdp(_port: number, _deps?: { fetchJson?: (url: string) => Promise<unknown>; openSocket?: (url: string) => SocketLike; timeoutMs?: number }): Promise<CdpSession> {
  return { send: async <T>() => ({}) as T, on: () => () => undefined, close: () => undefined };
}
export async function webviewFrameRect(_cdp: CdpSession, _size: { width: number; height: number }): Promise<{ left: number; top: number; width: number; height: number } | undefined> { return undefined; }
export async function mouseDrag(_cdp: CdpSession, _from: Point, _to: Point, _options?: { steps?: number; pauseMs?: number; whileOver?: () => Promise<void> }): Promise<void> { /* stub */ }
export async function interceptedDrag(_cdp: CdpSession, _from: Point, _to: Point, _options?: { timeoutMs?: number }): Promise<boolean> { return false; }
export async function pressKey(_cdp: CdpSession, _key: 'Escape' | 'Enter' | 'm'): Promise<void> { /* stub */ }
