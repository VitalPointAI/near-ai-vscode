import BrowserOnly from '@docusaurus/BrowserOnly';
import useBaseUrl from '@docusaurus/useBaseUrl';
import { useEffect, useState } from 'react';
import { DASHBOARD_PATH, parseDashboard } from '../../compliance/lib.mjs';
function Data({ children }) { const url = useBaseUrl(DASHBOARD_PATH); const [result, setResult] = useState(); useEffect(() => { let alive = true; fetch(url).then(async (response) => parseDashboard(await response.text(), response.headers.get('content-type') ?? '')).catch(() => ({ ok: false, reason: 'missing' })).then((next) => alive && setResult(next)); return () => { alive = false; }; }, [url]); if (!result) return <p aria-live="polite">Loading evidence…</p>; if (!result.ok) return <p role="status">No evidence yet: run compliance:refresh</p>; return children(result.dashboard); }
export default function AccreditationData({ children }) { return <BrowserOnly fallback={<p>Loading evidence…</p>}>{() => <Data>{children}</Data>}</BrowserOnly>; }
