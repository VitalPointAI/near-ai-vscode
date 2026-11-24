import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ContainerModule } from '@theia/core/shared/inversify';
import { TEAM_PREVIEW_PATH, TeamPreviewService } from '../common/team-preview.js';
import { teamPreviewReader } from './team-preview-reader.js';

export default new ContainerModule(bind => {
  bind(TeamPreviewService).toConstantValue(teamPreviewReader);
  bind(ConnectionHandler).toDynamicValue(context =>
    new RpcConnectionHandler(TEAM_PREVIEW_PATH, () => context.container.get<TeamPreviewService>(TeamPreviewService))
  ).inSingletonScope();
});
