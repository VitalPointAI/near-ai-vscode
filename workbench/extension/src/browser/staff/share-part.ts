/**
 * The browser part of Share with people (Phase 33 D-58, 33-27): the share service proxy, the section's mount on the work-area page, a page of its
 * own for an opened invitation, and the OpenHandler that opens .near-staff-invite files into the join flow already filled in. The section, its page
 * and the shell and file services are loaded on first use, so the staff frontend module stays light.
 */
import type { interfaces } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution.js';
import { OpenHandler } from '@theia/core/lib/browser/opener-service.js';
import { MessageService } from '@theia/core/lib/common/message-service.js';
import { STAFF_SHARE_PATH, StaffShareServer } from '../../common/staff-share.js';
import { bindFrontendService } from '../frontend-service.js';
import { InviteOpenHandler, type InvitationOpened } from './invite-open-handler.js';
import type { ShareWidget } from './share-widget.js';

let shareServer: StaffShareServer | undefined;

/**
 * The work-area page's one mount line (33-27): appends Share with people to the page and shows the open staff work's sharing. Nothing is mounted
 * when the staff modules are not loaded.
 */
export function mountShareSection(page: HTMLElement): { dispose(): void } | undefined {
  const server = shareServer;
  if (server === undefined) return undefined;
  const host = document.createElement('div');
  page.append(host);
  let disposed = false;
  let section: { dispose(): void } | undefined;
  void import('./share-widget.js').then(({ ShareWithPeopleSection }) => {
    if (disposed) return;
    const made = new ShareWithPeopleSection(server);
    section = made;
    host.append(made.node);
    void made.refresh();
  });
  return { dispose: () => { disposed = true; section?.dispose(); host.remove(); } };
}

class ShareSectionStarter implements FrontendApplicationContribution {
  constructor(private readonly server: () => StaffShareServer) {}

  onStart(): void {
    shareServer = this.server();
  }
}

const ShareStarterId = Symbol('ShareSectionStarter');

/** The browser part of Share with people (33-27). */
export function bindSharePart(bind: interfaces.Bind): void {
  bindFrontendService<StaffShareServer>(bind, StaffShareServer, STAFF_SHARE_PATH);
  bind(ShareStarterId).toDynamicValue((context) => new ShareSectionStarter(() => context.container.get<StaffShareServer>(StaffShareServer))).inSingletonScope();
  bind(FrontendApplicationContribution).toService(ShareStarterId);
  bind(OpenHandler).toDynamicValue((context) => {
    const { container } = context;
    const files = async () => {
      const { FileService } = await import('@theia/filesystem/lib/browser/file-service.js');
      return container.get<InstanceType<typeof FileService>>(FileService);
    };
    let widget: ShareWidget | undefined;
    const show = async (opened: InvitationOpened): Promise<void> => {
      const [{ shareWidgetOf, ShareWithPeopleSection }, { ApplicationShell }, { BaseWidget }] = await Promise.all([
        import('./share-widget.js'), import('@theia/core/lib/browser/shell/application-shell.js'), import('@theia/core/lib/browser/widgets/widget.js'),
      ]);
      const shell = container.get<InstanceType<typeof ApplicationShell>>(ApplicationShell);
      let current = widget;
      if (current === undefined || current.isDisposed) current = shareWidgetOf(BaseWidget, new ShareWithPeopleSection(container.get<StaffShareServer>(StaffShareServer)));
      widget = current;
      current.section.fillInvitation(opened);
      if (!current.isAttached) await shell.addWidget(current, { area: 'main' });
      await shell.activateWidget(current.id);
    };
    return new InviteOpenHandler({
      read: async (uri) => ({ value: (await (await files()).read(uri)).value }),
      size: async (uri) => (await (await files()).resolve(uri)).size,
    }, show, (text) => { void container.get<MessageService>(MessageService).warn(text); });
  }).inSingletonScope();
}
