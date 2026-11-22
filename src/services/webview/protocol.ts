import type { Webview } from 'vscode';

// The kit's message protocol (DEVELOPER-STRUCTURE section 2, D-26): every message from a page is untrusted.
// Parse exact keys and bounded values. Drop and count any malformed or unknown message.

/** Kit tab titles say what the page is, without a brand prefix. */
export const BRANDED_TITLE = /^(NEAR AI|Near AI)\s*:/i;

export type Plain = Record<string, unknown>;

export function exactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Plain {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return required.every(key => Object.hasOwn(value, key))
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key)));
}

export function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f-\x9f]/.test(value) ? value : undefined;
}

export function boundedInt(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

export interface PageProtocol<In, Out> {
  parseInbound(value: unknown): In | undefined;
}

export function definePage<In, Out>(parse: PageProtocol<In, Out>['parseInbound']): PageProtocol<In, Out> {
  return { parseInbound: parse };
}

export function postTo<Out>(webview: Pick<Webview, 'postMessage'>, message: Out): void {
  try {
    void Promise.resolve(webview.postMessage(message)).catch(() => undefined);
  } catch {
    // The webview may have gone away before the post.
  }
}

export function listenTo<In>(
  webview: Pick<Webview, 'onDidReceiveMessage'>,
  page: PageProtocol<In, unknown>,
  handler: (message: In) => void | Promise<void>
): { dispose(): void; dropped(): number } {
  let dropped = 0;
  const subscription = webview.onDidReceiveMessage(async (value: unknown) => {
    let message: In | undefined;
    try {
      message = page.parseInbound(value);
    } catch {
      // Treat a parser exception as a rejected message.
    }
    if (message === undefined) {
      dropped += 1;
      return;
    }
    try {
      await handler(message);
    } catch {
      // Handler failures do not count as malformed messages.
    }
  });
  return { dispose: () => subscription.dispose(), dropped: () => dropped };
}
