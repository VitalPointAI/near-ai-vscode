import BrowserOnly from '@docusaurus/BrowserOnly';
import useBaseUrl from '@docusaurus/useBaseUrl';
import { useEffect, useState } from 'react';
import { REFRESH_PATH } from '../../compliance/lib.mjs';
function Package() { const url = useBaseUrl(REFRESH_PATH); const [record, setRecord] = useState(); useEffect(() => { fetch(url).then((response) => response.ok ? response.json() : null).then(setRecord).catch(() => setRecord(null)); }, [url]); if (!record) return <p>No refresh record is available yet.</p>; const state = record.attestation === 'verified' ? 'verified' : record.attestation === 'none' ? 'none for daily bundles by design' : 'not checked; upgrade gh'; return <section><p>Source: {record.source}; commit: {record.commit}; refreshed: {record.fetchedAt}.</p><p>Manifest verified. Attestation: {state}.</p><p>{record.note}</p><h2>Verify a release package</h2><pre><code>{'sha256sum --check SHA256SUMS\ngh attestation verify <file> --repo <owner/repo>'}</code></pre></section>; }
export default function PackageInfo() { return <BrowserOnly fallback={<p>Loading refresh record…</p>}><Package /></BrowserOnly>; }
