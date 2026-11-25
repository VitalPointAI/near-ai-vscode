/**
 * Opening a .near-staff-invite file in SovAI (Phase 33 D-10, D-49, D-58; 33-27): a Theia OpenHandler that reads the file and opens Share with
 * people's join flow already filled in. It reads only what the join flow shows before the person answers (the shared work's name and the expiry);
 * the backend checks the whole invitation when the person joins. Nothing here imports Theia at run time, so the workbench test drives it.
 */
import type URI from '@theia/core/lib/common/uri.js';
import type { OpenHandler } from '@theia/core/lib/browser/opener-service.js';
import { INVITE_OPEN_TEXT } from '../../common/staff-share.js';

export const INVITE_EXTENSION = '.near-staff-invite';
/** An invitation file is a small signed payload; a larger file is not opened (the engine's MAX_PAYLOAD_BYTES). */
export const INVITE_MAX_BYTES = 256 * 1024;

/** What the join flow is filled in with. */
export interface InvitationOpened {
  readonly text: string;
  /** The shared work's name, as the invitation names it; shown to the person, never trusted. */
  readonly name?: string;
  readonly expiresAt?: string;
}

export { INVITE_OPEN_TEXT };

/** The fields shown before the person answers, read from the file's text; undefined fields when the text does not hold them. */
export function invitationFields(text: string): InvitationOpened {
  try {
    const payload = (JSON.parse(text) as { payload?: { name?: unknown; expiresAt?: unknown } }).payload;
    return {
      text,
      ...(typeof payload?.name === 'string' ? { name: payload.name } : {}),
      ...(typeof payload?.expiresAt === 'string' ? { expiresAt: payload.expiresAt } : {}),
    };
  } catch {
    return { text };
  }
}

export interface InviteFileReader {
  read(uri: URI): Promise<{ readonly value: string }>;
  size(uri: URI): Promise<number | undefined>;
}

export class InviteOpenHandler implements OpenHandler {
  readonly id = 'sterling.staff.invite';
  readonly label = 'Share with people';

  constructor(private readonly files: InviteFileReader, private readonly show: (opened: InvitationOpened) => void | Promise<void>, private readonly warn: (text: string) => void) {}

  canHandle(uri: URI): number {
    return uri.path.base.toLowerCase().endsWith(INVITE_EXTENSION) ? 500 : 0;
  }

  async open(uri: URI): Promise<undefined> {
    const size = await this.files.size(uri);
    if (size !== undefined && size > INVITE_MAX_BYTES) {
      this.warn(INVITE_OPEN_TEXT.tooLarge);
      return undefined;
    }
    let text: string;
    try {
      text = (await this.files.read(uri)).value;
    } catch {
      this.warn(INVITE_OPEN_TEXT.unreadable);
      return undefined;
    }
    if (text.length > INVITE_MAX_BYTES) {
      this.warn(INVITE_OPEN_TEXT.tooLarge);
      return undefined;
    }
    await this.show(invitationFields(text));
    return undefined;
  }
}
