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

const flows = [
  {
    label: 'Run a task',
    steps: ['Staff workspace', 'Agent and policy gate', 'Permitted tool or model'],
  },
  {
    label: 'Share within a mission',
    steps: ['Authorized workspace', 'Mission hub validates sealed changes', 'Eligible peer verifies and applies'],
  },
  {
    label: 'Discover data',
    state: 'Planned integration',
    steps: ['Approved source or node', 'Mission catalogue filters visibility', 'Source rechecks access on use'],
  },
  {
    label: 'Release across domains',
    state: 'Planned integration',
    steps: ['Authorized release package', 'Approved cross-domain transfer', 'Destination verifies and records acceptance'],
  },
  {
    label: 'Improve a model',
    state: 'Planned integration',
    steps: ['Approved corpus and workload', 'Training and held-out evaluation', 'Passport and separate activation'],
  },
  {
    label: 'Deploy an update',
    steps: ['Build and review', 'Approved digest or signed bundle', 'Workstation or verified site registry'],
  },
  {
    label: 'Review assurance',
    steps: ['Tests, audits and site evidence', 'Compliance engine', 'Assessor and authorizing official'],
  },
];

export function SystemArchitectureFlows() {
  return (
    <div className={styles.flowMap}>
      {flows.map(({ label, state, steps }) => (
        <div className={styles.flow} key={label}>
          <div className={styles.flowLabel}>
            <strong>{label}</strong>
            {state && <span>{state}</span>}
          </div>
          <ol className={styles.steps} aria-label={label}>
            {steps.map((step, index) => (
              <li key={step}>
                {index > 0 && <span aria-hidden="true" className={styles.arrow}>→</span>}
                <span className={styles.step}>{step}</span>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}
