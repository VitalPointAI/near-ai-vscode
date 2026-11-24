#!/bin/sh
# Install and start an RKE2 server node from the copied bundle folder (D-14). Runs as root on the node, which has no Node.js and no route out.
#
#   sh install-node.sh <bundle-node-folder>
#
# The folder holds, copied from the verified bundle:
#   pins.sha256                      "<sha256>  <file>" lines written by the bundle build from compliance/ci/tool-pins.json (the rke2 pin and
#                                    its assets) and deploy/bundle/images.lock.json (the registry's own image archive)
#   rke2.linux-amd64.tar.gz          the pinned RKE2 release
#   rke2-images-core.linux-amd64.tar.zst, rke2-images-canal.linux-amd64.tar.zst   RKE2's own images (Canal is the only FIPS-rebuilt CNI)
#   rke2-selinux-0.24-1.el9.noarch.rpm                                           installed when SELinux is enforcing
#   images/*.tar | *.tar.zst         extra image archives for containerd, such as the site registry's own image (it cannot be pulled from
#                                    before it exists, research Pitfall 8); each must be listed in pins.sha256
#   config.yaml registries.yaml audit-policy.yaml psa.yaml site-ca.crt   already site-substituted on the admin host with
#                                    node deploy/bundle/lib/render.mjs --site <site> --substitute <file>
#
# Every artifact's SHA-256 is checked against pins.sha256 before it is used; a file that is missing from the list, or does not match,
# stops the install before anything on the node changes.
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: install-node.sh <bundle-node-folder>" >&2
  exit 2
fi
DIR=$1
fail() { echo "install-node: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run as root"
[ "$(cat /proc/sys/crypto/fips_enabled 2>/dev/null || echo 0)" = 1 ] || fail "the host is not in FIPS mode (/proc/sys/crypto/fips_enabled is not 1); enable it (fips-mode-setup --enable) and reboot first"
[ -f "$DIR/pins.sha256" ] || fail "$DIR/pins.sha256 is missing"

# Check one file against its line in pins.sha256 (exact file name match, read line by line).
check() {
  name=$1
  [ -f "$DIR/$name" ] || fail "$DIR/$name is missing"
  want=$(while read -r hash file; do if [ "$file" = "$name" ]; then echo "$hash"; fi; done < "$DIR/pins.sha256")
  [ -n "$want" ] || fail "$name has no line in pins.sha256; refusing an unpinned artifact"
  have=$(sha256sum "$DIR/$name" | cut -d' ' -f1)
  [ "$have" = "$want" ] || fail "$name does not match its SHA-256 in pins.sha256; refusing it"
}

ENFORCING=no
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = Enforcing ]; then ENFORCING=yes; fi

for name in rke2.linux-amd64.tar.gz rke2-images-core.linux-amd64.tar.zst rke2-images-canal.linux-amd64.tar.zst; do check "$name"; done
if [ "$ENFORCING" = yes ]; then check rke2-selinux-0.24-1.el9.noarch.rpm; fi
EXTRA=""
if [ -d "$DIR/images" ]; then
  for path in "$DIR"/images/*.tar "$DIR"/images/*.tar.zst; do
    [ -f "$path" ] || continue
    check "images/$(basename "$path")"
    EXTRA="$EXTRA $path"
  done
fi
for name in config.yaml registries.yaml audit-policy.yaml psa.yaml site-ca.crt; do
  [ -f "$DIR/$name" ] || fail "$DIR/$name is missing"
  if grep -q '${site\.' "$DIR/$name"; then fail "$name still names a \${site.<key>} setting; substitute it on the admin host first"; fi
done

# CIS profile host requirements (research, RKE2 answers): the etcd user and group, and the kernel parameters.
id etcd >/dev/null 2>&1 || useradd -r -c "etcd user" -s /sbin/nologin -M etcd -U

if [ "$ENFORCING" = yes ]; then
  rpm -q rke2-selinux >/dev/null 2>&1 || rpm -i "$DIR/rke2-selinux-0.24-1.el9.noarch.rpm" \
    || fail "rke2-selinux did not install; it needs container-selinux from the site's OS repository"
fi

tar -xzf "$DIR/rke2.linux-amd64.tar.gz" -C /usr/local
install -m 0644 /usr/local/share/rke2/rke2-cis-sysctl.conf /etc/sysctl.d/60-rke2-cis.conf
sysctl --system >/dev/null

IMAGES=/var/lib/rancher/rke2/agent/images
mkdir -p "$IMAGES"
cp "$DIR/rke2-images-core.linux-amd64.tar.zst" "$DIR/rke2-images-canal.linux-amd64.tar.zst" "$IMAGES/"
for path in $EXTRA; do cp "$path" "$IMAGES/"; done
# With .cache.json present RKE2 imports only archives that changed since the last start.
[ -f "$IMAGES/.cache.json" ] || echo '{}' > "$IMAGES/.cache.json"

mkdir -p /etc/rancher/rke2
for name in config.yaml registries.yaml audit-policy.yaml psa.yaml site-ca.crt; do
  install -m 0600 "$DIR/$name" "/etc/rancher/rke2/$name"
done

systemctl daemon-reload
systemctl enable --now rke2-server.service
echo "install-node: rke2-server started; kubectl is /var/lib/rancher/rke2/bin/kubectl with KUBECONFIG=/etc/rancher/rke2/rke2.yaml" >&2
