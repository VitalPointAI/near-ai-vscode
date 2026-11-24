// `kubectl get -o json` and Prometheus `query_range` responses shaped like the real ones, for three sessions: ws-a (image pulled, so cold), ws-b
// (image already on the node, so warm) and ws-c (pod still Pending). Times are UTC on 2026-11-23.
const at = (time: string): string => `2026-11-23T${time}Z`;
export const ms = (time: string): number => Date.parse(at(time));

export const sessions = {
  kind: 'List',
  items: [
    { metadata: { name: 'session-ws-a', creationTimestamp: at('12:00:00') }, spec: { name: 'ws-a', user: 'loadtest-user-0001' }, status: { operatorStatus: 'HANDLED', url: 'site.example/ws-a/' } },
    { metadata: { name: 'session-ws-b', creationTimestamp: at('12:00:10') }, spec: { name: 'ws-b', user: 'loadtest-user-0002' }, status: { operatorStatus: 'HANDLED', url: 'site.example/ws-b/' } },
    { metadata: { name: 'session-ws-c', creationTimestamp: at('12:00:20') }, spec: { name: 'ws-c', user: 'loadtest-user-0003' }, status: { operatorStatus: 'HANDLING' } }
  ]
};

const deployment = (name: string, owner: string, created: string, claim: string): unknown => ({
  metadata: { name, creationTimestamp: at(created), ownerReferences: [{ kind: 'Session', name: owner }] },
  spec: { template: { spec: { volumes: [{ name: 'workspace', persistentVolumeClaim: { claimName: claim } }, { name: 'tmp', emptyDir: {} }] } } }
});
export const deployments = {
  kind: 'List',
  items: [
    deployment('ws-a-dep', 'session-ws-a', '12:00:02', 'pvc-a'),
    deployment('other-dep', 'someone-else', '12:00:05', 'pvc-x'),
    deployment('ws-b-dep', 'session-ws-b', '12:00:15', 'pvc-b'),
    deployment('ws-c-dep', 'session-ws-c', '12:00:21', 'pvc-c')
  ]
};

export const pods = {
  kind: 'List',
  items: [
    { metadata: { name: 'ws-a-dep-5f6c7-abc12' }, status: { phase: 'Running', conditions: [{ type: 'PodScheduled', status: 'True', lastTransitionTime: at('12:00:03') }, { type: 'Ready', status: 'True', lastTransitionTime: at('12:00:30') }] } },
    { metadata: { name: 'ws-b-dep-7d8e9-def34' }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True', lastTransitionTime: at('12:00:40') }] } },
    { metadata: { name: 'ws-c-dep-1a2b3-ghi56' }, status: { phase: 'Pending', conditions: [{ type: 'Ready', status: 'False', lastTransitionTime: at('12:00:22') }] } }
  ]
};

export const events = {
  kind: 'List',
  items: [
    { reason: 'Pulling', involvedObject: { kind: 'Pod', name: 'ws-a-dep-5f6c7-abc12' }, message: 'Pulling image "registry.example/workbench@sha256:..."' },
    { reason: 'Pulled', involvedObject: { kind: 'Pod', name: 'ws-b-dep-7d8e9-def34' }, message: 'Container image "registry.example/workbench@sha256:..." already present on machine' }
  ]
};

const rule = (path: string): unknown => ({ host: 'site.example', http: { paths: [{ path: `${path}(/|$)(.*)`, pathType: 'ImplementationSpecific', backend: { service: { name: path.slice(1), port: { number: 3000 } } } }] } });
/** The shared Ingress object at two samples: first with ws-a's rule, then with ws-a's and ws-b's, beside the site's own root rule. */
export const ingressFirst = { metadata: { name: 'theia-cloud-ingress' }, spec: { rules: [{ host: 'site.example', http: { paths: [{ path: '/', pathType: 'Prefix' }] } }, rule('/ws-a')] } };
export const ingressSecond = { metadata: { name: 'theia-cloud-ingress' }, spec: { rules: [{ host: 'site.example', http: { paths: [{ path: '/', pathType: 'Prefix' }] } }, rule('/ws-a'), rule('/ws-b')] } };

const series = (metric: Record<string, string>, values: Array<[string, string]>): unknown => ({ metric, values: values.map(([time, value]) => [ms(time) / 1000, value]) });
export const cpu = {
  status: 'success',
  data: {
    resultType: 'matrix',
    result: [
      series({ pod: 'ws-a-dep-5f6c7-abc12' }, [['12:01:00', '0.2'], ['12:01:30', '0.3']]),
      series({ pod: 'ws-b-dep-7d8e9-def34' }, [['12:01:00', '0.01'], ['12:01:30', '0.0300004']]),
      series({ pod: 'platform-pod' }, [['12:01:00', '2']])
    ]
  }
};
export const memory = {
  status: 'success',
  data: {
    resultType: 'matrix',
    result: [
      series({ pod: 'ws-a-dep-5f6c7-abc12' }, [['12:01:00', '1000000000'], ['12:01:30', '1200000001']]),
      series({ pod: 'ws-b-dep-7d8e9-def34' }, [['12:01:00', '300000000'], ['12:01:30', '300000000']])
    ]
  }
};
export const volume = {
  status: 'success',
  data: {
    resultType: 'matrix',
    result: [
      series({ persistentvolumeclaim: 'pvc-a' }, [['12:01:00', '500000000'], ['12:01:30', '700000000']]),
      series({ persistentvolumeclaim: 'pvc-b' }, [['12:01:00', '100000000']])
    ]
  }
};
export const etcdSize = { status: 'success', data: { resultType: 'matrix', result: [series({}, [['12:01:00', '90000000'], ['12:01:30', '100000000']])] } };
export const etcdObjects = { status: 'success', data: { resultType: 'matrix', result: [series({}, [['12:01:00', '3000'], ['12:01:30', '3100']])] } };
export const metricNames = ['up', 'apiserver_storage_size_bytes', 'etcd_mvcc_db_total_size_in_bytes', 'apiserver_storage_objects', 'etcd_disk_wal_fsync_duration_seconds_bucket'];
