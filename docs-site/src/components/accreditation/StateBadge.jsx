import { STATE_WORDS } from '../../compliance/lib.mjs';
const shapes = { met: '●', 'partly-met': '◐', 'not-met': '■', stale: '◌', 'not-applicable': '–', 'your-organizations-responsibility': '◆' };
export default function StateBadge({ state }) { return <span aria-label={STATE_WORDS[state] ?? state}><span aria-hidden="true">{shapes[state] ?? '•'} </span>{STATE_WORDS[state] ?? state}</span>; }
