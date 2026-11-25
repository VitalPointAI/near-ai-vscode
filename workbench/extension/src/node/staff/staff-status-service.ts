/**
 * The status service of shared projects (Phase 33 D-52, D-57): one per session backend, at STAFF_STATUS_PATH. Every connected tab is a client;
 * each row the live engine reports reaches every client as onStatus, and a join request reaches the clients only because the engine raises it
 * only on a lead or deputy device (D-12, T-33-N12). A client is dropped when its connection closes. Registering the module is 33-31: this file
 * exports bindStaffStatusService for it.
 */
import type { interfaces } from '@theia/core/shared/inversify';
import type { RpcProxy } from '@theia/core/lib/common/messaging/index.js';
import { STAFF_STATUS_PATH, STAFF_STATUS_TEXT, StaffStatusServer, type StaffStatusClient, type StaffStatusRow } from '../../common/staff-live.js';
import { ok, refused, type ServiceResult } from '../../common/service-result.js';
import { bindBackendService } from '../backend-service.js';
import type { StaffLiveEngine } from './staff-live-engine.js';

/** The live engine as the service reads it. */
export type StaffStatusSource = Pick<StaffLiveEngine, 'projects' | 'syncNow' | 'onStatus' | 'onJoinRequest'>;

export class StaffStatusService implements StaffStatusServer {
  private readonly clients = new Set<StaffStatusClient>();

  constructor(private readonly engine: () => StaffStatusSource | undefined) {}

  /** Wires the engine's rows and join requests to the clients; returns the subscriptions to dispose with the engine. */
  public attach(engine: StaffStatusSource): Array<{ dispose(): void }> {
    return [
      engine.onStatus((row) => { for (const client of [...this.clients]) client.onStatus(row); }),
      engine.onJoinRequest((request) => { for (const client of [...this.clients]) client.onJoinRequest(request); }),
    ];
  }

  /** A connecting tab: kept until its connection closes, and given every current row at once. */
  public addClient(client: RpcProxy<StaffStatusClient>): void {
    this.clients.add(client);
    client.onDidCloseConnection(() => { this.clients.delete(client); });
    for (const row of this.engine()?.projects() ?? []) client.onStatus(row);
  }

  public get clientCount(): number {
    return this.clients.size;
  }

  public async rows(): Promise<StaffStatusRow[]> {
    return this.engine()?.projects() ?? [];
  }

  public async syncNow(project: string): Promise<ServiceResult<StaffStatusRow>> {
    const row = this.engine()?.syncNow(project);
    return row === undefined ? refused(STAFF_STATUS_TEXT.notOpen) : ok(row);
  }
}

/** Binds the status service and its RPC path, with every tab as a client. `engine` gives the session's live engine once it has started. */
export function bindStaffStatusService(bind: interfaces.Bind, engine: (context: interfaces.Context) => () => StaffStatusSource | undefined): void {
  bindBackendService<StaffStatusService, StaffStatusClient>(bind, StaffStatusServer, STAFF_STATUS_PATH, (context) => new StaffStatusService(engine(context)),
    (service, client) => service.addClient(client));
}
