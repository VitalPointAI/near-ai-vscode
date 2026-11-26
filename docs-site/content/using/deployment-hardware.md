---
sidebar_label: Deployment hardware
---

# Recommended hardware and configuration

Use this bill of materials to plan a development setup or a first site. The quantities below
are **starting configurations to validate on your hardware**. Where a minimum is known, the
guide calls it out. The Workbench, hub, and full site do not yet have measured minimum CPU,
memory, and disk requirements. Use an existing machine for the lab before ordering hardware
for a site.

## What runs where

| Role | Recommended starting bill of materials | What it provides |
| --- | --- | --- |
| Staff workstation | One existing Linux x86-64 PC per user, 4 logical CPUs, 16 GiB RAM and 100 GiB free on the local SSD for Docker and workspace files. No local GPU is needed when inference runs elsewhere. | Runs the local Sterling Workbench container and opens it in the user's browser. Can open projects and chat through a reachable, approved model endpoint. |
| Optional shared hub | One Linux x86-64 VM to start, 2 vCPUs, 4 GiB RAM and a 64 GiB SSD. Keep hub state on persistent encrypted storage and make the service reachable from the participating network. | Runs the hub service for shared staff projects. The current Workbench release lets administrators prepare the hub. Editor-project connection is pending. |
| Same-machine development | One workstation with 8 logical CPUs, 32 GiB RAM and 150 GiB free SSD space as a starting target. Run the Workbench and hub as separate containers on the same Docker engine. | Builds and tests the local browser experience and hub service on one machine. Each service has its own persistent volume and can be started or stopped independently. |
| Single-machine site lab | One Linux x86-64 host with hardware virtualization and KVM, 12 logical CPUs, 48 GiB RAM and 512 GiB free on SSD storage for the guest and bundle staging. Start with an 8 vCPU, 32 GiB RHEL-9-compatible guest and budget a 400 GiB encrypted guest disk, subject to the usable-space checks below. | Exercises the offline site configuration for the registry, cluster networking, certificates, sign-in, secrets, one hub and the placeholder Workbench flow. Installing the complete signed lab bundle on this configuration still requires validation. |
| On-prem site pilot | Three Linux x86-64 RHEL-9-compatible servers or VMs as a starting topology, each with 8 vCPUs, 32 GiB RAM and a 250 GiB SSD for the OS, cluster state and image cache. Add separate capacity for encrypted application volumes and backups. Place VMs across independent physical hosts when testing host failure. | Runs the site's cluster, sign-in, secrets, registry, audit services, hubs and hosted Workbench. This topology provides a place to test failover and restore. Production sizing depends on measured workload, retention and recovery tests. |
| Inference host, optional | Use an existing approved model endpoint or size one separate model server for the chosen weights, context and workload. Purchase a compatible accelerator only after selecting and testing the model and runtime. | Serves models to approved Workbench clients. A user can also run a suitably sized supported model on their workstation. |
| Shared storage and backup | Use the organization's existing encrypted storage where it meets the role, or provision separate storage capacity for application volumes, shared data and backups. Keep a backup copy in an independent failure domain. | Holds shared datasets or persistent service data, depending on the connection and access policy. Supports recovery after loss of a server or storage system. |

Registry, identity, secrets, audit and hosted Workbench normally run as services in the same site
cluster. They do not each need their own physical server for a pilot. Reserve separate hardware
for inference when its resource use would compete with those services, and for a hardware security
module when the site's key custody design calls for one. A NAS may be its own appliance or an
existing service operated by your organization.

## Workstation, hub and inference configuration

- **Workstation.** The launcher requires a Linux x86-64 or ARM64 host, a matching local Docker
  Engine 28 or newer, and Node.js 26.13.1 or newer in the 26 series. The current release image is
  Linux x86-64, which covers Intel and AMD. Signed Linux ARM64 publication is pending. Run the
  launcher check before setup and use the exact approved image digest. Its CPU and RAM readings
  describe what Docker sees. Validate free space and a representative project on the target machine.
  [Getting started](./getting-started.md)
- **Hub.** The Kubernetes chart requests 0.1 CPU and 128 MiB RAM per hub, with a 512 MiB memory
  limit. Size the persistent state volume for the projects it serves and their activity. The lab
  sets that volume to 1 GiB. These figures describe the service allocation. Budget separately for
  the host's OS and container engine, and exercise sync and restore at the intended load.
  [Hub chart](https://github.com/VitalPointAI/near-ai-vscode/blob/main/deploy/hub/values.yaml)
- **Inference.** Keep space for model files and the runtime's cache. Size usable VRAM or unified
  memory for the weights, context cache and runtime overhead, with headroom for the OS and any
  colocated Workbench. For CPU inference use system RAM. Test the exact approved model and context
  with representative inputs and measure response time before choosing hardware.
- **Messaging relay, optional.** Run it only where a supported messaging integration needs it.
  Use an integration host or VM that can reach the relevant network. The Compose example caps
  relay memory at 512 MiB and uses a persistent state volume. That cap is a container setting.
  Size the VM and volume from observed traffic and retention. The relay can run independently
  of the hub. [Relay operator guide](https://github.com/VitalPointAI/near-ai-vscode/blob/main/relay/README.md)

## Site component sizing

These source settings show how each service consumes hardware. They are chart allocations or site
examples. Use rendered requests and measurements to size the cluster.

| Component | Capability | Configuration to size |
| --- | --- | --- |
| RKE2 | Runs the cluster and its control plane. | Upstream minimum is 2 CPUs and 4 GB RAM. The site workloads run in addition to that platform. Put etcd on a low-latency SSD. [RKE2 requirements](https://docs.rke2.io/install/requirements#hardware) |
| Zot or Harbor | Stores approved images for local use. | The example requests 200 GiB for Zot. Harbor's example requests 500 GiB for its registry and 10 GiB for its database. Size for the bundle, retained versions and room to import the next bundle. [Zot](https://github.com/VitalPointAI/near-ai-vscode/blob/main/deploy/values/site.example/zot.yaml) · [Harbor](https://github.com/VitalPointAI/near-ai-vscode/blob/main/deploy/values/site.example/harbor.yaml) |
| Keycloak and PostgreSQL | Provide sign-in and retain identity data. | The Keycloak example requests 0.5 CPU and 1 GiB RAM per replica. PostgreSQL requests 0.25 CPU and 512 MiB RAM, with 20 GiB each for database and dumps. [Keycloak](https://github.com/VitalPointAI/near-ai-vscode/blob/main/deploy/values/site.example/keycloakx.yaml) · [PostgreSQL](https://github.com/VitalPointAI/near-ai-vscode/blob/main/deploy/values/site.example/sterling-postgres.yaml) |
| OpenBao and key custody | Store secrets and protect site keys. | The OpenBao example requests 0.25 CPU and 256 MiB RAM per server, 10 GiB per data volume and 5 GiB for snapshots. Plan for the approved HSM, custody and recovery arrangements in the key ceremony. [OpenBao](https://github.com/VitalPointAI/near-ai-vscode/blob/main/deploy/values/site.example/openbao.yaml) · [Key ceremony](https://github.com/VitalPointAI/near-ai-vscode/blob/main/deploy/runbooks/key-ceremony.md) |
| OpenSearch and Fluent Bit | Collect and search audit records and logs. | The OpenSearch example requests 1 CPU, 4 GiB RAM and 200 GiB per data node, plus 200 GiB of snapshot storage. Size from measured log ingest and retention requirements. [OpenSearch](https://github.com/VitalPointAI/near-ai-vscode/blob/main/deploy/values/site.example/opensearch.yaml) |
| Prometheus and ingress | Provide metrics, alerting and access to site services. | The Prometheus example requests 0.5 CPU, 2 GiB RAM and 50 GiB storage. The ingress example requests 0.25 CPU and 256 MiB RAM per HAProxy replica. Include network, admission and certificate services in the cluster's resource budget. [Prometheus](https://github.com/VitalPointAI/near-ai-vscode/blob/main/deploy/values/site.example/prometheus.yaml) · [Ingress](https://github.com/VitalPointAI/near-ai-vscode/blob/main/deploy/values/site.example/kubernetes-ingress.yaml) |
| Hosted Workbench | Runs browser-accessible workspace workloads inside the cluster. | Use the chart's resource settings and size persistent workspace storage from the site's retention rules. Use load runs to establish supported demand. [Workbench chart](https://github.com/VitalPointAI/near-ai-vscode/blob/main/deploy/charts/sterling-sessions/values.yaml) · [Capacity evidence](https://github.com/VitalPointAI/near-ai-vscode/blob/main/docs/hosting/capacity.md) |

### Lab disk

The 18-release offline lab preview requests 247 GiB of fixed volumes. Zot accounts for 200
GiB, PostgreSQL data and dumps account for 40 GiB, OpenBao data and snapshots account for 6 GiB,
and the hub accounts for 1 GiB. Add 1 GiB for the first retained test workspace, space for the
separately provisioned OpenBao token volume, and room for the guest OS, image layers, etcd, logs
and a restore. The VM script defaults to 4 vCPUs, 8 GiB RAM and a nominal 40G disk. That disk
cannot back those requests. Confirm real usable
space on the host and guest before installing. The lab uses encrypted static volumes on the guest.
Set `LAB_CPUS` and `LAB_MEMORY` for the proposed guest, raise `LAB_MEMORY_MAX` to leave room for
QEMU overhead, and set `LAB_DISK` from the confirmed disk budget. A larger virtual disk alone
does not create or bind the required volumes. [Lab VM settings](https://github.com/VitalPointAI/near-ai-vscode/blob/main/deploy/lab/vm.sh)

### Example pilot storage configuration

For a three-node pilot using Zot, start the sizing exercise with three OpenBao servers, two
Keycloak replicas, three OpenSearch data nodes, and one hub. Set the hub volume to 10 GiB and
reserve a 100 GiB pool for retained workspaces in this example. The example volumes above
then total 1,235 GiB of logical capacity, before any other configured volumes, backups outside
the cluster or restore headroom. With three Longhorn copies of every volume in that subtotal,
allow 3,705 GiB of physical capacity for those copies alone. An initial hardware candidate is
an additional 2 TiB usable SSD per node for application storage, separate from the OS disk.
Use the actual StorageClass replica policy and the complete rendered volume inventory to
recalculate. The three-node topology gives you a place to test failure and recovery, including
the behavior of single-replica services.

### Storage and site acceptance

For a site, use the reference encrypted Longhorn class or a supported, organization-managed
encrypted storage class. An organization-managed NAS can hold shared datasets or backups. To
back live databases on network storage, verify workload compatibility with its access modes,
write durability, latency and restore behavior. Share access to datasets according to the site's
policy while keeping the data on its approved storage.

Before ordering for production, render the actual site configuration. Budget for all PVCs,
storage replication, retained workspaces, snapshots, image updates and restore headroom.
Run setup and a representative workload on the proposed hardware, then verify service health,
disk headroom and recovery against your organization's targets. Provide the site's approved
time source, DNS and PKI, install media and backup destination.
[Site install runbook](https://github.com/VitalPointAI/near-ai-vscode/blob/main/deploy/runbooks/site-install.md)
