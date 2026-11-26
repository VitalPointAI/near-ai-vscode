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

function BlueprintFigure({ blueprint, caption }) {
  const imageUrl = useBaseUrl(blueprint.props.src);
  return (
    <figure className={styles.blueprint}>
      <a href={imageUrl} aria-label={`Open ${caption.toLowerCase()} at full resolution`}>
        {React.cloneElement(blueprint, { src: imageUrl })}
      </a>
      <figcaption>{caption} · Open for full resolution</figcaption>
    </figure>
  );
}

export default function SystemArchitectureMap({ children }) {
  const artwork = useBaseUrl('/img/sovai-system-architecture.webp');
  const [physical, system] = React.Children.toArray(children);
  return (
    <div className={styles.map}>
      <BlueprintFigure blueprint={physical} caption="Physical deployment blueprint" />
      <BlueprintFigure blueprint={system} caption="System architecture blueprint" />
      <figure className={styles.navigation}>
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
    </div>
  );
}

export function SystemArchitectureFlows({ children }) {
  return (
    <figure className={styles.flowMap}>
      <figcaption>SovAI data flows and interactions</figcaption>
      {children}
    </figure>
  );
}
