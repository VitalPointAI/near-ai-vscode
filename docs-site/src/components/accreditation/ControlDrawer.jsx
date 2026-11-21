import { useEffect, useRef, useState } from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import { TEXT_BASE } from '../../compliance/lib.mjs';
import styles from './styles.module.css';
const safeHttps = (url, githubOnly = false) => /^https:\/\//.test(url ?? '') && (!githubOnly || /^https:\/\/github\.com\//.test(url));
export default function ControlDrawer({ row, textIndex, onClose, opener }) {
  const close = useRef(null); const [text, setText] = useState(); const path = textIndex?.find((item) => item.family === row.family)?.file;
  const url = useBaseUrl(path ? `${TEXT_BASE}${path}` : '');
  useEffect(() => { if (!url) return; fetch(url).then((response) => response.ok ? response.json() : null).then(setText).catch(() => setText(null)); }, [url]);
  useEffect(() => { close.current?.focus(); const key = (event) => { if (event.key === 'Escape') { onClose(); opener?.focus(); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [onClose, opener]);
  const official = text?.controls?.find((item) => item.id === row.control || item.label === row.label);
  return <aside className={styles.drawer} aria-label={`Details for ${row.label}`}><button type="button" ref={close} onClick={() => { onClose(); opener?.focus(); }}>Close details</button><h3>{row.label}: {row.title}</h3><h4>Official text</h4>{official ? <>{safeHttps(official.url) ? <a href={official.url}>Official source</a> : null}<p>{official.prose ?? official.title}</p>{official.french ? <details><summary>Français</summary><p>{official.french}</p></details> : null}</> : <p>Official text is not present in this dashboard.</p>}<h4>Our statement</h4>{row.components?.map((component) => <section key={component.component}><p><strong>Our statement:</strong> {component.statement ?? row.reasonText}</p><p><strong>Responsibility:</strong> {component.responsibility}</p><h5>Evidence</h5><ul>{(component.evidence ?? []).map((evidence) => <li key={`${evidence.rule}-${evidence.collectedAt}`}>{evidence.rule}; {evidence.collectedAt}; {evidence.commit?.slice(0, 12) ?? 'no commit'} {safeHttps(evidence.runUrl, true) ? <a href={evidence.runUrl}>CI run</a> : null}</li>)}</ul></section>)}{row.gap ? <section><h4>Gap</h4><p>{row.gap.remediation}; owner: {row.gap.ownerRole}; {row.gap.phase ?? row.gap.poam}</p></section> : null}{row.acceptedUntil ? <p>Risk accepted until {row.acceptedUntil}</p> : null}</aside>;
}
