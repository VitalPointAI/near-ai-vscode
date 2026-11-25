#!/usr/bin/env python3
"""Reproduces the applicability estimate of 44.1-RESEARCH.md sections 4 and 5.

Planning research, not product code: it applies the DRAFT facet rules of 44.1-RESEARCH.md section 3 to a generated
dashboard projection and prints what a signed map would change. 44.1-06 turns these rules into
compliance/applicability/rules.json and the TypeScript generator; from 44.1-07 the measured count of
`node compliance/src/cli.ts coverage` replaces this estimate.

Usage (read-only; writes nothing unless --out is given):
  python3 -I .planning/phases/44.1-accreditation-control-implementation-and-evidence-closure/44.1-applicability-estimate.py \
      [--dashboard ~/.local/share/sterling-local/compliance/dashboard.json] [--out <empty folder for pairs.json>]

The published figures were measured on the main bundle of 32007751 (generatedAt 2026-11-25T04:36:29Z). Rebuild the
dashboard from a later main to re-measure.
"""
import argparse, collections, json, os

I, S = 'implements', 'supports'
ALL_BUT = lambda *skip: [c for c in COMPONENTS if c not in skip]
COMPONENTS = ['extension', 'workbench', 'model-endpoints', 'relay', 'hub', 'release-pipeline', 'rke2', 'image-registry',
              'ingress', 'cert-manager', 'keycloak', 'theia-cloud', 'oauth2-proxy', 'openbao', 'hsm', 'site-storage',
              'site-logging', 'offline-bundle']

# Section 3.1: facet -> (implements, supports).
FACETS = {
    'access-decisions': (['extension', 'workbench', 'relay', 'hub', 'rke2', 'oauth2-proxy', 'openbao'], ['image-registry', 'keycloak', 'theia-cloud', 'site-logging']),
    'accounts': (['hub', 'rke2', 'keycloak'], ['extension', 'workbench', 'relay', 'image-registry', 'theia-cloud', 'openbao', 'site-logging']),
    'audit-records': (['extension', 'workbench', 'relay', 'hub', 'rke2', 'image-registry', 'ingress', 'keycloak', 'theia-cloud', 'oauth2-proxy', 'openbao', 'site-logging'], ['offline-bundle']),
    'audit-store': (['extension', 'site-logging'], ['hub', 'openbao', 'site-storage']),
    'authenticators': (['extension', 'hub', 'keycloak', 'openbao'], ['workbench', 'relay', 'rke2', 'image-registry', 'cert-manager', 'theia-cloud', 'oauth2-proxy', 'site-logging']),
    'traffic-limits': (['relay', 'rke2', 'ingress'], ['hub', 'keycloak', 'theia-cloud']),
    'backup-restore': (['hub', 'openbao', 'site-storage'], ['rke2', 'keycloak', 'hsm', 'site-logging', 'offline-bundle']),
    'boundary-traffic': (['extension', 'workbench', 'relay', 'rke2', 'ingress'], ['model-endpoints', 'hub', 'oauth2-proxy', 'offline-bundle']),
    'our-code': (['extension', 'workbench', 'relay', 'hub', 'offline-bundle'], ['keycloak', 'theia-cloud', 'oauth2-proxy']),
    'change-path': (['release-pipeline', 'offline-bundle'], ['rke2', 'image-registry', 'keycloak']),
    'cryptography': (ALL_BUT('model-endpoints'), ['model-endpoints']),
    'organization-data': (['extension', 'workbench', 'hub', 'rke2', 'keycloak', 'openbao', 'site-storage', 'site-logging'], ['model-endpoints', 'relay']),
    'development': (['release-pipeline'], ['extension', 'workbench', 'relay', 'hub', 'keycloak', 'theia-cloud', 'oauth2-proxy', 'offline-bundle']),
    'device-identity': (['extension', 'hub'], ['workbench', 'relay', 'rke2']),
    'name-resolution': ([], ['rke2']),
    'two-person-control': (['openbao'], ['hub', 'release-pipeline', 'site-storage']),
    'external-service': (['model-endpoints'], ['extension', 'workbench', 'relay', 'release-pipeline']),
    'federation': (['keycloak'], []),
    'hardware': (['hsm'], ['offline-bundle']),
    'host-hardening': ([], ['workbench', 'rke2']),
    'integrity-checks': (['image-registry', 'offline-bundle'], ['site-logging']),
    'process-isolation': (['rke2'], ['extension', 'workbench', 'relay', 'hub', 'theia-cloud']),
    'labels': (['extension', 'workbench', 'hub'], ['model-endpoints', 'relay']),
    'malicious-code-checks': (['image-registry'], ['extension', 'workbench', 'release-pipeline', 'offline-bundle']),
    'user-interface': (['extension', 'workbench'], ['keycloak', 'theia-cloud']),
    'crypto-module-login': (['hsm'], ['openbao']),
    'monitoring': (['site-logging'], ['extension', 'workbench', 'relay', 'hub', 'rke2', 'image-registry', 'ingress', 'keycloak', 'openbao']),
    'network-traffic': (['extension', 'workbench', 'model-endpoints', 'relay', 'hub', 'rke2', 'image-registry', 'ingress', 'keycloak', 'theia-cloud', 'oauth2-proxy', 'openbao', 'site-logging'], ['cert-manager', 'hsm', 'site-storage']),
    'outside-users': (['relay', 'keycloak'], ['hub']),
    'unauthenticated-entry': (['keycloak', 'oauth2-proxy'], ['relay', 'hub', 'ingress', 'theia-cloud']),
    'pki-trust': (['cert-manager', 'openbao'], ['extension', 'workbench', 'relay', 'hub', 'rke2', 'image-registry', 'ingress', 'keycloak', 'theia-cloud', 'oauth2-proxy', 'site-logging']),
    'certificate-issuing': (['cert-manager', 'openbao'], ['hub', 'rke2']),
    'supplier-process': (['release-pipeline'], []),
    'privileged-remote': ([], ['rke2', 'keycloak', 'openbao']),
    'identity-proofing': ([], ['keycloak']),
    're-authentication': (['keycloak'], ['workbench', 'oauth2-proxy', 'openbao']),
    'remote-access': (['ingress', 'oauth2-proxy'], ['relay', 'hub', 'rke2', 'keycloak', 'theia-cloud', 'openbao']),
    'sessions': (['keycloak', 'theia-cloud', 'oauth2-proxy'], ['workbench', 'relay', 'hub', 'image-registry', 'openbao', 'site-logging']),
    'shared-resources': (['rke2'], ['workbench', 'hub', 'theia-cloud', 'site-storage']),
    'sign-in': (['relay', 'hub', 'keycloak', 'oauth2-proxy'], ['extension', 'workbench', 'rke2', 'image-registry', 'theia-cloud', 'openbao', 'site-logging']),
    'sign-in-page': (['keycloak'], []),
    'separation-of-duties': ([], ['hub', 'release-pipeline', 'rke2', 'keycloak', 'openbao']),
    'software': (ALL_BUT('model-endpoints', 'hsm'), ['model-endpoints', 'hsm']),
    'time-source': (['rke2'], []),
    'admin-separation': (['workbench', 'keycloak'], ['extension', 'relay', 'hub', 'rke2', 'image-registry', 'theia-cloud', 'openbao', 'site-logging']),
    'software-installation': (['workbench', 'image-registry'], ['extension', 'rke2', 'offline-bundle']),
}
CARRIES = collections.defaultdict(set)
for facet, (imp, sup) in FACETS.items():
    for c in imp + sup:
        CARRIES[c].add(facet)

# Section 3.2: control -> facets. NONE = no product facet (applicable only where a statement exists).
NONE = ()
RULES = {}
def rule(ids, *facets):
    for i in ids.split():
        RULES[i] = facets
rule('ac-01 au-01 cm-01 cp-01 ia-01 ir-01 pl-01 ra-01 sa-01 sc-01 si-01 sr-01 ac-22 cm-10', 'supplier-process')
rule('ir-02 ir-03 ir-03.02 ir-04.03 ir-04.08 ir-04.09 ir-06 ir-06.02 ir-06.03 ir-07 ir-07.01 ir-08', 'supplier-process')
rule('pl-02 pl-08 pl-10 pl-11 ra-03 ra-03.01 ra-05.11 ra-09 sa-04 sa-04.01 sa-04.10 sa-04.12 si-05', 'supplier-process')
rule('sr-02 sr-02.01 sr-05 sr-06 sr-08 sr-11.01', 'supplier-process')
rule('ac-02 ac-02.01 ac-02.02 ac-02.03 ac-02.04 ac-02.07 ac-02.10 ac-02.13 ac-06.05 ac-06.07 ia-04 ia-04.04', 'accounts')
rule('ac-03 ac-03.04 ac-06 ac-06.01 ac-06.02 ac-06.09 ac-06.10', 'access-decisions')
rule('ac-03.02 cp-09.07', 'two-person-control')
rule('ac-03.09 ac-04 ac-16 ac-16.02 ac-21 ac-21.400 ac-21.401', 'labels')
rule('ac-16.05 sc-18 sc-18.01 sc-18.02 sc-18.03 sc-18.04 sc-18.05', 'user-interface')
rule('ac-05', 'separation-of-duties')
rule('ac-07 ac-08 ac-09 ia-06 ia-05.08', 'sign-in-page')
rule('ia-02 ia-02.01 ia-02.02 ia-02.08 ia-02.10 ia-05.01', 'sign-in')
rule('ac-02.05 ac-12 sc-10 sc-23.01 sc-23.03', 'sessions')
rule('ac-14', 'unauthenticated-entry')
rule('ac-17 ac-17.01 ac-17.02 ac-17.03', 'remote-access')
rule('ac-17.04 ac-17.400', 'privileged-remote')
rule('au-02 au-03 au-03.01 au-05 au-08 au-12', 'audit-records')
rule('au-04 au-04.01 au-05.01 au-06 au-06.01 au-06.03 au-06.04 au-07 au-07.01 au-09 au-09.02 au-09.04 au-09.06 au-11 au-12.01', 'audit-store')
rule('cm-02 cm-02.02 cm-02.03 cm-06 cm-07 cm-07.01 cm-08 cm-08.01 cm-08.04 cm-08.06 ra-05 ra-05.02 sa-04.09 sa-05 sa-22 si-02 si-02.02 si-07 si-07.01 sr-03 sr-11', 'software')
rule('cm-02.06 cm-04.01 sa-03 sa-08 sa-10 sa-10.01 sa-10.07 sa-11 sa-15 sa-15.03 sa-16 sa-17', 'development')
rule('cm-03 cm-03.02 cm-03.04 cm-04 cm-04.02 cm-05 cm-09', 'change-path')
rule('cm-07.02 cm-07.05 cm-11 cm-11.02', 'software-installation')
rule('cm-08.03 si-07.02 si-07.03 si-07.07', 'integrity-checks')
rule('cm-12 cm-12.01 sc-28 sc-28.01 si-12', 'organization-data')
rule('cp-02 cp-04', 'backup-restore', 'supplier-process')
rule('cp-09 cp-09.01 cp-09.03 cp-09.05 cp-09.08 cp-10 cp-10.02 cp-10.04 cp-10.06', 'backup-restore')
rule('ia-03', 'device-identity')
rule('ia-05 ia-05.06 ia-05.13', 'authenticators')
rule('ia-05.02 ia-05.14', 'pki-trust')
rule('ia-05.07', 'our-code', 'change-path')
rule('ia-05.09', 'federation')
rule('ia-07', 'crypto-module-login')
rule('ia-08 ia-08.01 ia-08.02 ia-08.04', 'outside-users')
rule('ia-11', 're-authentication')
rule('ia-12 ia-12.02 ia-12.03 ia-12.04 ia-12.05', 'identity-proofing')
rule('ir-04 ir-05 ir-06.01 si-04 si-04.02 si-04.04 si-04.05 si-04.10 si-04.11 si-04.12 si-04.13', 'monitoring')
rule('sa-09 sa-09.01 sa-09.02 sa-09.08 sa-400', 'external-service')
rule('sc-02', 'admin-separation')
rule('sc-04', 'shared-resources')
rule('sc-05 sc-05.02', 'traffic-limits')
rule('sc-07 sc-07.03 sc-07.04 sc-07.05 sc-07.08 sc-07.09 sc-07.11', 'boundary-traffic')
rule('sc-08 sc-08.01 sc-23', 'network-traffic')
rule('sc-12 sc-12.01 sc-13', 'cryptography')
rule('sc-17', 'certificate-issuing')
rule('sc-20 sc-21 sc-22', 'name-resolution')
rule('sc-39', 'process-isolation')
rule('sc-45', 'time-source')
rule('si-03 si-03.04', 'malicious-code-checks')
rule('si-10 si-11', 'our-code')
rule('si-16', 'host-hardening')
rule('sr-10 sr-11.02 sr-12', 'hardware')
rule('ac-11 ac-11.01 ac-18 ac-18.01 ac-18.03 ac-18.04 ac-19 ac-19.05 ac-20 ac-20.01 ac-20.02 ac-20.04 cm-02.07', *NONE)
rule('cp-02.01 cp-02.02 cp-02.03 cp-02.08 cp-03 cp-04.01 cp-06 cp-06.01 cp-06.03 cp-07 cp-07.01 cp-07.02 cp-07.03 cp-07.04 cp-07.06', *NONE)
rule('cp-08 cp-08.01 cp-08.02 cp-08.03 cp-08.05 pl-04 pl-04.01 ra-02 ra-05.05 ra-07 sa-02 sc-07.07 sc-07.12 sc-07.13', *NONE)
rule('sc-15 sc-15.03 sc-29 si-04.14 si-04.15 si-08 si-08.02 si-400', *NONE)

# Pairs reserved by sibling plans (44.1-HANDOFFS.md): their statements will make them applicable.
RESERVED = set()
def reserve(component, ids):
    for i in ids.split():
        RESERVED.add((component, i))
reserve('workbench', 'sc-28 ia-05 sc-12 sc-13 ia-02 sc-07 cm-02 pl-02 ra-02 ra-03 ra-09 ir-04 ir-08 pm-05.01 pm-25 at-03 ac-16 pl-04')
reserve('release-pipeline', 'cm-02 cm-08 si-07 sr-03 sr-04 sr-11 sa-10 sa-09 cm-03 cm-05 si-02 ir-01 si-05')
reserve('keycloak', 'sc-13 si-02 ia-02 ia-05 au-02 au-12 sc-08 sc-28')
reserve('theia-cloud', 'sc-13 sa-10 sr-03 sr-11 si-07 sc-08 sc-23 au-02 au-12 cm-02 cm-07')
reserve('oauth2-proxy', 'sc-13 sc-08 sc-23 ia-05 ia-02')
reserve('openbao', 'sc-12 sc-13 au-09 sc-12.01 ac-05 au-09.04')
reserve('hsm', 'sc-12 sc-13 sr-05 sr-10 sr-12')
reserve('rke2', 'sc-13 sc-12 cm-06 au-02 au-12 cm-07 ca-09 pl-08 sa-17 ac-06')
reserve('ingress', 'sc-13 sc-08 cm-07')
reserve('image-registry', 'si-07 ra-05 cm-08 ia-02 au-12 sc-13')
reserve('cert-manager', 'sc-12 sc-23')
reserve('site-storage', 'sc-28 mp-06')
reserve('site-logging', 'au-09 au-05 si-04.05 au-06 au-09.02 au-11 si-12 ca-07')
reserve('hub', 'cm-06 ac-03 ia-05.02 ac-21 ac-21.400 ac-21.401 ps-06')
reserve('offline-bundle', 'ca-03 sr-06 sr-08 sr-11')
reserve('extension', 'au-05 cm-02 si-02 ac-04 ac-16 ac-21 ca-03 sc-08 sc-16 sc-16.01')
reserve('model-endpoints', 'sa-09 sa-09.08 sa-400 cm-06 cm-08 sa-04 sa-11 sr-03 sr-04 ac-16 au-02 au-03 au-10 cp-02 si-04 si-07')
for c in ('workbench', 'release-pipeline'):  # 48.2-15
    reserve(c, 'ca-07 cm-02 cm-08 sa-11 ra-05 ra-05.02 si-04 au-05 au-06 si-07 si-07.01 sr-04')

INVENTORY = set('cm-02 cm-02.02 cm-02.03 cm-08 cm-08.01 cm-08.04 cm-08.06 ra-05 ra-05.02 sa-05 sa-22 si-02 si-02.02 si-07 si-07.01 sr-03 sr-11'.split())
STAGE = {'unclassified': 1, 'protected-a': 1, 'hosted-protected-a': 1, 'protected-b': 2, 'hosted-protected-b': 2}


def classify(component, control):
    """applicable or not-applicable for a pair with no statement; None when no rule covers the control."""
    if (component, control) in RESERVED:
        return 'applicable'
    facets = RULES.get(control, RULES.get(control.split('.')[0]))
    if facets is None:
        return None
    return 'applicable' if CARRIES[component] & set(facets) else 'not-applicable'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dashboard', default=os.path.expanduser('~/.local/share/sterling-local/compliance/dashboard.json'))
    ap.add_argument('--out')
    args = ap.parse_args()
    d = json.load(open(args.dashboard))
    print(f"dashboard {args.dashboard}: commit {d['commit']}, generated {d['generatedAt']}")
    cells = [(r, c) for r in d['rows'] for c in r['components']]
    no_stmt = [(r, c) for r, c in cells if c['reason'] == 'no-statement']
    print(f"rows {len(d['rows'])}, cells {len(cells)}, no-statement cells {len(no_stmt)}")

    unmapped, by_comp, by_stage = set(), collections.defaultdict(collections.Counter), collections.defaultdict(collections.Counter)
    for r, c in no_stmt:
        if r['level'] == 'classified':
            continue
        k = classify(c['component'], r['control'])
        if k is None:
            unmapped.add(r['control'])
            continue
        by_comp[c['component']][k] += 1
        by_stage[STAGE[r['level']]][k] += 1
    na = sum(v['not-applicable'] for v in by_comp.values())
    ap_ = sum(v['applicable'] for v in by_comp.values())
    print(f"unmapped controls: {sorted(unmapped) or 'none'}")
    print(f"not applicable to the component: {na}; still applicable without a statement: {ap_}; appliance cells untouched: "
          f"{sum(1 for r, c in no_stmt if r['level'] == 'classified')}")
    for s in sorted(by_stage):
        print(f"  stage {s}: not applicable {by_stage[s]['not-applicable']}, applicable {by_stage[s]['applicable']}")
    print('component,cells now,applicable,not applicable')
    for comp, cnt in sorted(by_comp.items(), key=lambda x: -sum(x[1].values())):
        print(f"{comp},{sum(cnt.values())},{cnt['applicable']},{cnt['not-applicable']}")

    # Rows whose every component has no part: they read your organization's responsibility (no-component-applies).
    rows_none = collections.defaultdict(list)
    for r in d['rows']:
        if r['level'] not in STAGE or not r['components']:
            continue
        if all(c['reason'] == 'no-statement' and classify(c['component'], r['control']) == 'not-applicable' for c in r['components']):
            rows_none[r['level']].append(r['control'])
    print('rows no component has a part in, by stage: ' + ', '.join(
        f"stage {s} {sum(len(v) for l, v in rows_none.items() if STAGE[l] == s)}" for s in (1, 2)))
    for level in ('protected-a', 'hosted-protected-a'):
        print(f"  {level} ({len(rows_none[level])}): {' '.join(rows_none[level])}")

    pairs = {(c['component'], r['control']) for r, c in no_stmt
             if r['level'] != 'classified' and classify(c['component'], r['control']) == 'applicable'}
    reserved = {p for p in pairs if p in RESERVED}
    inventory = {p for p in pairs if p[1] in INVENTORY and p not in reserved}
    hand = pairs - reserved - inventory
    print(f"applicable pairs without a statement: {len(pairs)} (reserved by sibling plans {len(reserved)}, "
          f"inventory-generated {len(inventory)}, hand-written {len(hand)})")
    fam = collections.defaultdict(collections.Counter)
    for comp, ctl in hand:
        fam[comp][ctl.split('-')[0]] += 1
    for comp in sorted(fam, key=lambda k: -sum(fam[k].values())):
        print(f"  {comp}: {sum(fam[comp].values())} " + ', '.join(f'{k} {v}' for k, v in sorted(fam[comp].items(), key=lambda x: -x[1])))
    unclassified = sorted({(c['component'], r['control']) for r, c in no_stmt
                           if r['level'] == 'unclassified' and classify(c['component'], r['control']) == 'applicable'})
    print(f"unclassified applicable pairs without a statement: {len(unclassified)}")
    if args.out:
        json.dump(sorted(pairs), open(os.path.join(args.out, 'pairs.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
