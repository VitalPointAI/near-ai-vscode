import React from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './SystemArchitectureMap.module.css';

const areas = [
  {
    id: 'workbench-and-agents',
    title: 'Workbench and agents',
    description: 'Staff workspaces, teams, tools and the agent runtime.',
    position: '1.4% 2.7%',
  },
  {
    id: 'trust-and-policy',
    title: 'Trust and policy',
    description: 'Identity, classification, capabilities and approvals.',
    position: '50% 2.7%',
  },
  {
    id: 'sites-and-mission-networks',
    title: 'Sites and mission networks',
    description: 'Workstations, hosted sessions, hubs and messaging.',
    position: '98.6% 2.7%',
  },
  {
    id: 'governed-data-platform',
    title: 'Governed data platform',
    description: 'Sources, discovery, stewardship, search and analytics.',
    position: '1.4% 97.3%',
  },
  {
    id: 'models-and-model-factory',
    title: 'Models and Model Factory',
    description: 'Approved inference, training, evaluation and passports.',
    position: '50% 97.3%',
  },
  {
    id: 'how-a-release-is-shipped',
    title: 'Release and assurance',
    description: 'Supply chain, site deployment, operations and evidence.',
    position: '98.6% 97.3%',
  },
];

export default function SystemArchitectureMap() {
  const artwork = useBaseUrl('/img/sovai-system-architecture.webp');
  return (
    <figure className={styles.map}>
      <figcaption>Choose an area to see its components and responsibilities.</figcaption>
      <ul className={styles.areas}>
        {areas.map(({ id, title, description, position }) => (
          <li key={id}>
            <a className={styles.area} href={`#${id}`}>
              {/* The adjacent text supplies the accessible name and purpose. */}
              <span
                aria-hidden="true"
                className={styles.illustration}
                style={{ backgroundImage: `url("${artwork}")`, backgroundPosition: position }}
              />
              <span className={styles.copy}>
                <strong>{title}</strong>
                <span>{description}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </figure>
  );
}

export function SystemArchitectureFlows({ children }) {
  return <div className={styles.flowMap}>{children}</div>;
}
