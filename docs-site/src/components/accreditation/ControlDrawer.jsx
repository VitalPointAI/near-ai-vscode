import { useEffect, useRef, useState } from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import { controlTextPath } from '../../compliance/lib.mjs';
import styles from './styles.module.css';
import StateBadge from './StateBadge';
// The applicability map's classes (44.1, D-07), in the words a reader sees.
const APPLICABILITY_WORDS = { implements: 'Implements', supports: 'Supports', 'not-applicable': 'Not applicable to this component' };
const safeHttps = (url, githubOnly = false) => /^https:\/\//.test(url ?? '') && (!githubOnly || /^https:\/\/github\.com\//.test(url));
export default function ControlDrawer({ row, gap, textIndex, onClose, opener }) {
  const close = useRef(null); const [text, setText] = useState();
  const path = controlTextPath(row, textIndex);
  const url = useBaseUrl(path);
  useEffect(() => {
    setText(null);
    if (!path) return;
    const request = new AbortController();
    fetch(url, { signal: request.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((value) => { if (!request.signal.aborted) setText(value); })
      .catch(() => { if (!request.signal.aborted) setText(null); });
    return () => request.abort();
  }, [path, url]);
  useEffect(() => { close.current?.focus(); const key = (event) => { if (event.key === 'Escape') { onClose(); opener?.focus(); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [onClose, opener]);
  const official = text?.controls?.find((item) => item.id === row.control);
  const attribution = text?.attribution;
  const frenchParts = official?.parts?.filter((part) => part.lang === 'fr') ?? [];
  const paragraphs = (parts) => parts.map((part, index) => <p key={`${part.name}-${index}`}>{part.prose}</p>);
  return (
    <aside className={styles.drawer} aria-label={`Details for ${row.label}`}>
      <button type="button" ref={close} onClick={() => { onClose(); opener?.focus(); }}>Close details</button>
      <h3>{row.label}: {row.title}</h3>
      <h4>Official text</h4>
      {official ? <>
        <p>{safeHttps(attribution?.url) ? <a href={attribution.url}>{attribution.source}</a> : attribution?.source}
          {attribution?.licence ? ` (${attribution.licence})` : ''}</p>
        <p>{attribution?.notice}</p>
        {paragraphs(official.parts?.filter((part) => part.lang === 'en') ?? [])}
        {frenchParts.length > 0 && <details lang="fr"><summary>Français</summary>{paragraphs(frenchParts)}</details>}
      </> : <p>Official text is not present in this dashboard.</p>}
      <h4>Our statement</h4>
      {row.components?.map((component) => <section key={component.component}>
        <h5>{component.component}: <StateBadge state={component.state} /></h5>
        {component.applicability && <p><strong>Applicability:</strong> {APPLICABILITY_WORDS[component.applicability] ?? component.applicability}</p>}
        <p><strong>Our statement:</strong> {component.statement ?? component.reasonText}</p>
        <p><strong>Responsibility:</strong> {component.responsibility}</p>
        <h5>Evidence</h5>
        <ul>{(component.evidence ?? []).map((evidence) => <li key={`${evidence.rule}-${evidence.collectedAt}`}>{evidence.rule}; {evidence.collectedAt}; {evidence.commit?.slice(0, 12) ?? 'no commit'} {safeHttps(evidence.runUrl, true) ? <a href={evidence.runUrl}>CI run</a> : null}</li>)}</ul>
      </section>)}
      {gap && <section><h4>Gap</h4><p>{gap.remediation}; owner: {gap.ownerRole}; {gap.phase ?? gap.poam}</p></section>}
      {gap?.acceptedUntil && <p>Risk accepted until {gap.acceptedUntil}</p>}
    </aside>
  );
}
