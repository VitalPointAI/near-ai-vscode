/**
 * The native Staff Room (Phase 33 D-59): a Theia ReactWidget that draws the rooms the backend builds with the live model (StaffRoomLiveView) and
 * sends each action back. It holds no text of its own: the room's words come from the model, the widget's from STAFF_ROOM_TEXT. The decision dialog
 * opens only after the backend took the version's decision stamp (beginDecision), and a confirmation that is too old sends the person to confirm with
 * their passkey or security key; the same decision finishes when they come back (D-24, D-60).
 */
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { MessageService } from '@theia/core/lib/common/message-service.js';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget.js';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution.js';
import type { ServiceResult } from '../../common/service-result.js';
import { StaffStatusServer } from '../../common/staff-live.js';
import { STAFF_ROOM_TEXT, StaffRoomServer, type StaffRoom, type StaffRoomAction, type StaffSignedResult } from '../../common/staff-room.js';
import { reasonsFieldId, StaffRoomEvents, staffRoomView } from './staff-room-view.js';
import './staff-room.css';

@injectable()
export class StaffRoomWidget extends ReactWidget {
  static readonly ID = 'sterling-staff-room';

  @inject(StaffRoomServer) protected readonly server!: StaffRoomServer;
  @inject(StaffStatusServer) protected readonly status!: StaffStatusServer;
  @inject(StaffRoomEvents) protected readonly events!: StaffRoomEvents;
  @inject(MessageService) protected readonly messages!: MessageService;

  @postConstruct()
  protected init(): void {
    this.id = StaffRoomWidget.ID;
    this.title.label = STAFF_ROOM_TEXT.title;
    this.title.caption = STAFF_ROOM_TEXT.title;
    this.title.iconClass = 'codicon codicon-organization';
    this.title.closable = true;
    this.addClass('sterling-staff-room-widget');
    this.toDispose.push(this.events.onDidChange(() => this.update()));
    void this.server.rooms().then((rooms) => { for (const room of rooms) this.events.onRoom(room); });
    this.update();
  }

  protected render(): unknown {
    return staffRoomView(this.events.rooms, {
      act: (room, action) => { void this.act(room, action); },
      decide: (room, outcome) => { void this.decide(room, outcome); },
      cancel: (room) => { if (room.pending !== undefined) void this.server.cancelDecision(room.pending.ticket); },
    });
  }

  private async act(room: StaffRoom, action: StaffRoomAction): Promise<void> {
    switch (action.id) {
      case 'sync-now':
        return this.answer(await this.status.syncNow(room.project));
      case 'approve':
      case 'reject':
        if (action.product !== undefined && action.hash !== undefined) await this.answer(await this.server.beginDecision(room.project, action.product, action.hash, true), true);
        return;
      case 'admit':
        return this.answer(await this.server.admit(room.project, action.invite ?? ''));
      case 'decline':
        return this.answer(await this.server.decline(room.project, action.invite ?? ''));
      case 'choose':
        return this.answer(await this.server.choose(room.project, action.branch ?? ''));
      case 'propose':
        return this.answer(await this.server.propose(room.project, action.product ?? ''));
      case 'dismiss':
        return this.server.dismiss(room.project, action.product ?? '', action.hash ?? '');
      case 'switch-keys':
        return this.signed(await this.server.switchToV2(room.project, this.here()));
      case 'move-keys':
      case 'move-keys-now':
        return this.signed(await this.server.moveCellsToV2(room.project, action.id === 'move-keys-now', this.here()));
      case 'give-keys':
        return this.signed(await this.server.giveKeys(room.project, this.here()));
      case 'make-copy':
        await this.messages.info(STAFF_ROOM_TEXT.copyLater);
        return;
      default:
        await this.messages.info(room.view.bar.sentence);
    }
  }

  private async decide(room: StaffRoom, outcome: 'approve' | 'reject'): Promise<void> {
    const pending = room.pending;
    if (pending === undefined) return;
    const field = this.node.querySelector<HTMLTextAreaElement>(`#${CSS.escape(reasonsFieldId(room))}`);
    const reasons = (field?.value ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '');
    return this.signed(await this.server.decide(pending.ticket, outcome, reasons, this.here()), STAFF_ROOM_TEXT.decided);
  }

  /** This page's path, where a confirmation with the passkey or security key comes back to. */
  private here(): string {
    return `${window.location.pathname}${window.location.search}`;
  }

  /** An act signed by the person key: done (the room redraws), refused with its sentence, or a trip to confirm first. */
  private async signed(result: StaffSignedResult<unknown>, done?: string): Promise<void> {
    if (result.kind === 'ok') {
      if (done !== undefined) await this.messages.info(done);
      return;
    }
    if (result.kind === 'step-up') {
      const choice = await this.messages.warn(result.reason, result.fix);
      if (choice === result.fix) window.location.assign(result.url);
      return;
    }
    await this.messages.warn(result.fix === undefined ? result.reason : `${result.reason} ${result.fix}`);
  }

  private async answer(result: ServiceResult<unknown>, quiet = false): Promise<void> {
    if (result.kind === 'refused') await this.messages.warn(result.fix === undefined ? result.reason : `${result.reason} ${result.fix}`);
    else if (!quiet) this.update();
  }
}

export const STAFF_ROOM_TOGGLE = 'sterling.staffRoom.toggle';

@injectable()
export class StaffRoomContribution extends AbstractViewContribution<StaffRoomWidget> {
  constructor() {
    super({
      widgetId: StaffRoomWidget.ID,
      widgetName: STAFF_ROOM_TEXT.title,
      defaultWidgetOptions: { area: 'right' },
      toggleCommandId: STAFF_ROOM_TOGGLE,
    });
  }
}
