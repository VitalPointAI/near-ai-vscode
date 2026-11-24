#!/usr/bin/env bash
# The air-gapped lab virtual machine (D-55): one RHEL-9-compatible guest with no route out, used by every lab spike and the final lab run.
#
#   deploy/lab/vm.sh up                 create the VM from the operator's guest image and boot it (FIPS mode on, one reboot); waits for SSH
#   deploy/lab/vm.sh ssh [command...]   a shell, or one command, in the guest as the user `lab` (passwordless sudo)
#   deploy/lab/vm.sh copy <src> <dest>  copy a host file or folder into the guest (scp over the SSH forward)
#   deploy/lab/vm.sh down               power the guest off and stop the unit, which releases the heavy-run lock
#   deploy/lab/vm.sh status             whether the VM unit is running
#
# Settings (environment):
#   LAB_GUEST_IMAGE   path of a RHEL-9-compatible cloud qcow2 the operator supplies (for example Rocky Linux 9 or AlmaLinux 9 GenericCloud);
#                     the repository pins no OS image, because a site brings its own OS
#   LAB_GUEST_SHA256  its SHA-256; `up` refuses an image that does not match
#   LAB_DIR           the VM's folder (disk overlay, disk key, seed, SSH key, console log); required
#   LAB_MEMORY        guest memory, default 8G; LAB_CPUS vCPUs, default 4; LAB_DISK the overlay size, default 40G
#   LAB_MEMORY_MAX    the unit's memory cap, default 10G (owner item E5: above the 4 GiB test cap, one heavy run at a time)
#   LAB_LOCK          the host-wide heavy-run lock, default $XDG_RUNTIME_DIR/sterling-heavy-run.lock, held for the VM's whole life
#   LAB_TIMEOUT       the VM's longest life in seconds, default 14400; LAB_SSH_PORT the host-only SSH forward, default 2222
#
# The guest network is QEMU user networking with restrict=on: the guest cannot reach the host or anything outside; the only path in is
# the SSH forward on 127.0.0.1. The disk is a LUKS-encrypted qcow2 overlay on the read-only guest image, so lab volumes are encrypted at
# rest; its key is a random file in LAB_DIR. Nothing is downloaded here.
set -euo pipefail

usage() {
  echo "usage: vm.sh up | ssh [command...] | copy <src> <dest> | down | status" >&2
  exit 2
}
[ "$#" -ge 1 ] || usage
COMMAND=$1
shift

UNIT=sterling-lab-vm
LAB_DIR=${LAB_DIR:-}
LAB_MEMORY=${LAB_MEMORY:-8G}
LAB_CPUS=${LAB_CPUS:-4}
LAB_DISK=${LAB_DISK:-40G}
LAB_MEMORY_MAX=${LAB_MEMORY_MAX:-10G}
LAB_LOCK=${LAB_LOCK:-${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/sterling-heavy-run.lock}
LAB_TIMEOUT=${LAB_TIMEOUT:-14400}
LAB_SSH_PORT=${LAB_SSH_PORT:-2222}

need_dir() {
  if [ -z "$LAB_DIR" ]; then
    echo "vm.sh: set LAB_DIR to the VM's folder" >&2
    exit 2
  fi
}
ssh_args() {
  printf '%s\n' -i "$LAB_DIR/id_ecdsa" -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$LAB_DIR/known_hosts" \
    -o IdentitiesOnly=yes -o HostKeyAlgorithms=ecdsa-sha2-nistp256 -o ConnectTimeout=5 -o BatchMode=yes -o LogLevel=ERROR
}
guest() {
  local args
  mapfile -t args < <(ssh_args)
  ssh "${args[@]}" -p "$LAB_SSH_PORT" lab@127.0.0.1 "$@"
}
running() { systemctl --user is-active --quiet "$UNIT"; }

wait_ssh() {
  local deadline=$((SECONDS + ${1:-900}))
  until guest true 2>/dev/null; do
    if ! running; then
      echo "vm.sh: the VM unit stopped; see $LAB_DIR/console.log and journalctl --user -u $UNIT" >&2
      exit 1
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "vm.sh: no SSH answer from the guest in time; see $LAB_DIR/console.log" >&2
      exit 1
    fi
    sleep 5
  done
}

# The cloud-init NoCloud seed. A seed ISO or FAT image is made with the first tool found; with none, QEMU's own read-only vvfat driver
# presents the seed folder as a disk labelled CIDATA, so no host tool is needed.
seed_drive() {
  local seed=$LAB_DIR/seed
  if command -v cloud-localds >/dev/null; then
    cloud-localds "$LAB_DIR/seed.img" "$seed/user-data" "$seed/meta-data"
    echo "if=virtio,format=raw,readonly=on,file=$LAB_DIR/seed.img"
  elif command -v xorriso >/dev/null; then
    xorriso -as mkisofs -quiet -output "$LAB_DIR/seed.img" -volid CIDATA -joliet -rock "$seed/user-data" "$seed/meta-data"
    echo "if=virtio,format=raw,readonly=on,file=$LAB_DIR/seed.img"
  elif command -v genisoimage >/dev/null; then
    genisoimage -quiet -output "$LAB_DIR/seed.img" -volid CIDATA -joliet -rock "$seed/user-data" "$seed/meta-data"
    echo "if=virtio,format=raw,readonly=on,file=$LAB_DIR/seed.img"
  elif command -v mkfs.vfat >/dev/null && command -v mcopy >/dev/null; then
    rm -f "$LAB_DIR/seed.img"
    mkfs.vfat -n CIDATA -C "$LAB_DIR/seed.img" 2048 >/dev/null
    mcopy -i "$LAB_DIR/seed.img" "$seed/user-data" "$seed/meta-data" ::
    echo "if=virtio,format=raw,readonly=on,file=$LAB_DIR/seed.img"
  else
    echo "vm.sh: no cloud-localds, xorriso, genisoimage or mkfs.vfat with mcopy on this host; using QEMU's vvfat seed disk" >&2
    echo "if=virtio,format=raw,readonly=on,file.driver=vvfat,file.dir=$seed,file.label=CIDATA,file.fat-type=16"
  fi
}

up() {
  need_dir
  : "${LAB_GUEST_IMAGE:?vm.sh: set LAB_GUEST_IMAGE to the guest cloud image}"
  : "${LAB_GUEST_SHA256:?vm.sh: set LAB_GUEST_SHA256 to the guest image SHA-256}"
  if running; then
    echo "vm.sh: $UNIT is already running" >&2
    exit 1
  fi
  for tool in qemu-system-x86_64 qemu-img ssh scp ssh-keygen sha256sum flock choom systemd-run; do
    command -v "$tool" >/dev/null || { echo "vm.sh: $tool is not on PATH" >&2; exit 1; }
  done
  [ -w /dev/kvm ] || { echo "vm.sh: /dev/kvm is not writable for this user" >&2; exit 1; }
  echo "$LAB_GUEST_SHA256  $LAB_GUEST_IMAGE" | sha256sum --check --strict --quiet || {
    echo "vm.sh: $LAB_GUEST_IMAGE does not match LAB_GUEST_SHA256; refusing it" >&2
    exit 1
  }
  mkdir -p "$LAB_DIR/seed"
  chmod 0700 "$LAB_DIR"
  [ -f "$LAB_DIR/id_ecdsa" ] || ssh-keygen -q -t ecdsa -b 256 -N '' -C sterling-lab -f "$LAB_DIR/id_ecdsa"
  rm -f "$LAB_DIR/known_hosts"
  if [ ! -f "$LAB_DIR/disk.qcow2" ]; then
    (umask 077 && head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$LAB_DIR/disk.key")
    qemu-img create -q -f qcow2 --object "secret,id=sec0,file=$LAB_DIR/disk.key" \
      -o "encrypt.format=luks,encrypt.key-secret=sec0" -b "$(realpath "$LAB_GUEST_IMAGE")" -F qcow2 "$LAB_DIR/disk.qcow2" "$LAB_DISK"
  fi
  cat > "$LAB_DIR/seed/meta-data" <<EOF
instance-id: sterling-lab-$(date +%s)
local-hostname: sterling-lab
EOF
  cat > "$LAB_DIR/seed/user-data" <<EOF
#cloud-config
users:
  - name: lab
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    lock_passwd: true
    ssh_authorized_keys:
      - $(cat "$LAB_DIR/id_ecdsa.pub")
ssh_pwauth: false
runcmd:
  - [sh, -c, "fips-mode-setup --enable"]
power_state:
  mode: reboot
  condition: true
EOF
  local seed
  seed=$(seed_drive)
  # -vga std stays: without a display adapter the guest firmware never reaches the boot loader (found in spike S2).
  : > "$LAB_DIR/console.log"
  echo "vm.sh: starting $UNIT (waits for the heavy-run lock $LAB_LOCK; memory cap $LAB_MEMORY_MAX)" >&2
  systemd-run --user --unit="$UNIT" --collect -q -p MemoryMax="$LAB_MEMORY_MAX" -p MemorySwapMax=0 -- \
    flock "$LAB_LOCK" choom -n 1000 -- timeout "$LAB_TIMEOUT" qemu-system-x86_64 -enable-kvm -cpu host -m "$LAB_MEMORY" -smp "$LAB_CPUS" \
    -nodefaults -vga std -display none -monitor none -serial "file:$LAB_DIR/console.log" \
    -object "secret,id=sec0,file=$LAB_DIR/disk.key" \
    -drive "if=virtio,format=qcow2,file=$LAB_DIR/disk.qcow2,encrypt.key-secret=sec0" \
    -drive "$seed" \
    -netdev "user,id=net0,restrict=on,ipv6=off,hostfwd=tcp:127.0.0.1:$LAB_SSH_PORT-:22" -device virtio-net-pci,netdev=net0
  # First boot enables FIPS mode and reboots; the second boot is the one that counts.
  wait_ssh 1800
  local deadline=$((SECONDS + 900))
  until [ "$(guest cat /proc/sys/crypto/fips_enabled 2>/dev/null || true)" = 1 ]; do
    [ "$SECONDS" -lt "$deadline" ] || { echo "vm.sh: the guest did not come back in FIPS mode; see $LAB_DIR/console.log" >&2; exit 1; }
    sleep 10
  done
  echo "vm.sh: the guest is up in FIPS mode; ssh with: LAB_DIR=$LAB_DIR deploy/lab/vm.sh ssh" >&2
}

case "$COMMAND" in
  up) [ "$#" -eq 0 ] || usage; up ;;
  ssh) need_dir; guest "$@" ;;
  copy)
    [ "$#" -eq 2 ] || usage
    need_dir
    mapfile -t args < <(ssh_args)
    scp -q -r "${args[@]}" -P "$LAB_SSH_PORT" "$1" "lab@127.0.0.1:$2"
    ;;
  down)
    [ "$#" -eq 0 ] || usage
    need_dir
    if running; then
      guest sudo systemctl poweroff 2>/dev/null || true
      for _ in $(seq 1 24); do running || break; sleep 5; done
      if running; then systemctl --user stop "$UNIT"; fi
    fi
    echo "vm.sh: $UNIT is stopped; the heavy-run lock is released" >&2
    ;;
  status)
    [ "$#" -eq 0 ] || usage
    if running; then echo "running"; else echo "stopped"; exit 1; fi
    ;;
  *) usage ;;
esac
