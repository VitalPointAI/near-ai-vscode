/**
 * The staff frontend module (Phase 33 D-52), as registered in package.json: the bindings of staff-frontend-core.ts with the five browser parts that
 * 33-25 to 33-29 fill in. It imports only browser and common files: no engine, Yjs or key module reaches the browser bundle (D-51).
 */
import { createStaffFrontendModule, type StaffFrontendParts } from './staff-frontend-core.js';
import { bindBindingPart } from './staff/binding-part.js';
import { bindPresencePart } from './staff/presence-part.js';
import { bindSharePart } from './staff/share-part.js';
import { bindStaffRoomPart } from './staff/staff-room-part.js';
import { bindStatusPart } from './staff/status-part.js';

export { createStaffFrontendModule, StaffStatusEvents, type StaffFrontendParts } from './staff-frontend-core.js';

const PARTS: StaffFrontendParts = { binding: bindBindingPart, presence: bindPresencePart, staffRoom: bindStaffRoomPart, share: bindSharePart, status: bindStatusPart };

export default createStaffFrontendModule(PARTS);
