import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution.js';
import { MessageService } from '@theia/core/lib/common/message-service.js';
import { bindFrontendService } from './frontend-service.js';
import { SESSION_ACTIVITY_PATH, SESSION_ACTIVITY_TEXT, SessionActivityService, type SessionActivityState } from '../common/session-activity.js';

/**
 * The person's side of idle stop (common/session-activity.ts). When the session runs under Theia Cloud's activity tracker, a key, a pointer,
 * a scroll or a touch on the page is reported to the backend, at most once every 30 seconds; the state is read once a minute, and when Theia
 * Cloud asked for the warning, one notification says the session stops soon and offers Keep working. In any other session (local mode, or
 * no tracker) the backend says `off` and nothing is listened to or asked again.
 */
const REPORT_EVERY_MS = 30_000;
const POLL_MS = 60_000;
const USE_EVENTS = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart'] as const;

@injectable()
class SessionActivityView implements FrontendApplicationContribution {
  @inject(SessionActivityService) private readonly service!: SessionActivityService;
  @inject(MessageService) private readonly messages!: MessageService;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private listening = false;
  private lastReport = 0;
  private warned = false;

  onStart(): void {
    void this.poll();
  }

  onStop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
  }

  private async poll(): Promise<void> {
    let state: SessionActivityState | undefined;
    try {
      state = await this.service.state();
    } catch {
      // The backend did not answer this time; ask again at the next poll.
    }
    if (state === 'off') return;
    if (state !== undefined) {
      this.listen();
      this.show(state);
    }
    this.timer = setTimeout(() => void this.poll(), POLL_MS);
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    for (const type of USE_EVENTS) window.addEventListener(type, () => this.used(), { capture: true, passive: true });
  }

  private used(now = Date.now(), always = false): void {
    if (!always && now - this.lastReport < REPORT_EVERY_MS) return;
    this.lastReport = now;
    this.service.report().then((state) => this.show(state), () => {
      // Not reported; the next use tries again.
      this.lastReport = 0;
    });
  }

  /** One notification per warning, not one per poll; any use ends the warning. */
  private show(state: SessionActivityState): void {
    if (state !== 'idle-warned') {
      this.warned = false;
      return;
    }
    if (this.warned) return;
    this.warned = true;
    void this.messages.warn(SESSION_ACTIVITY_TEXT.idleWarning, SESSION_ACTIVITY_TEXT.keepWorking).then((choice) => {
      if (choice === SESSION_ACTIVITY_TEXT.keepWorking) this.used(Date.now(), true);
    });
  }
}

export default new ContainerModule(bind => {
  bindFrontendService<SessionActivityService>(bind, SessionActivityService, SESSION_ACTIVITY_PATH);
  bind(SessionActivityView).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(SessionActivityView);
});
