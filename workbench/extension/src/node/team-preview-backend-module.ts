import { ContainerModule } from '@theia/core/shared/inversify';
import { TEAM_PREVIEW_PATH, TeamPreviewService } from '../common/team-preview.js';
import { bindBackendService } from './backend-service.js';
import { createTeamPreviewReader } from './team-preview-reader.js';

export default new ContainerModule(bind => {
  bindBackendService<TeamPreviewService>(bind, TeamPreviewService, TEAM_PREVIEW_PATH, () => createTeamPreviewReader());
});
