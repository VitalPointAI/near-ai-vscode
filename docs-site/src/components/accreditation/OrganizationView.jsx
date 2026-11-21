import BrowserOnly from '@docusaurus/BrowserOnly';
import { useEffect, useState } from 'react';
import { DASHBOARD_PATH, OVERLAY_ENDPOINT, mergeOverlay, parseDashboard, parseOverlayIndex } from '../../compliance/lib.mjs';
import ResponsibilityMatrix from './ResponsibilityMatrix';
import LevelPage from './LevelPage';
function View() { const [result, setResult] = useState(); useEffect(() => { Promise.all([fetch(DASHBOARD_PATH).then(async (response) => parseDashboard(await response.text(), response.headers.get('content-type') ?? '')), fetch(OVERLAY_ENDPOINT).then((response) => response.ok ? response.json() : null).then(parseOverlayIndex)]).then(([dashboard, overlay]) => setResult(dashboard.ok && overlay.ok ? mergeOverlay(dashboard.dashboard, overlay.files.map((file) => file.overlay)) : null)).catch(() => setResult(null)); }, []); if (!result) return <p>Private overlay is unavailable. Start the local production server with an overlay folder.</p>; return <section><p>Private overlay data is merged in this browser only.</p><ResponsibilityMatrix dashboard={result} />{(result.levels ?? []).map((level) => <LevelPage key={level.id} dashboard={result} levelId={level.id} />)}</section>; }
export default function OrganizationView() { return <BrowserOnly fallback={<p>Loading private overlay…</p>}><View /></BrowserOnly>; }
