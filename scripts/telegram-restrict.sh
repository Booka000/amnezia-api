#!/bin/sh
# ============================================================================
# telegram-restrict.sh
#
# Restricts one AmneziaWG peer (by its tunnel IP) to Telegram-owned IP
# ranges only, using an isolated iptables chain. Designed to be run INSIDE
# an already-running Alpine-based AmneziaWG container (no image rebuild).
#
# USAGE (from the host):
#   docker cp telegram-restrict.sh <container>:/usr/local/bin/telegram-restrict.sh
#   docker exec <container> chmod +x /usr/local/bin/telegram-restrict.sh
#   docker exec <container> /usr/local/bin/telegram-restrict.sh <peer_ip> [iface] [conf_path]
#
# Example:
#   docker exec awg-container /usr/local/bin/telegram-restrict.sh 10.66.66.2
#
# To REMOVE the restriction for a peer:
#   docker exec <container> /usr/local/bin/telegram-restrict.sh 10.66.66.2 awg0 "" --remove
#
# Safe to re-run: rules are rebuilt in a dedicated chain each time, so
# running this twice for the same peer does not stack duplicate rules.
# ============================================================================
set -eu

PEER_IP="${1:?Usage: $0 <peer_tunnel_ip> [interface] [conf_path] [--remove]}"
IFACE="${2:-awg0}"
CONF_PATH="${3:-/opt/amnezia/awg/${IFACE}.conf}"
ACTION="${4:-}"

CHAIN="AWG_TG_$(echo "$PEER_IP" | tr '.' '_')"
RULES_DIR="/etc/iptables"
RULES_FILE="${RULES_DIR}/rules-save"
SELF_PATH="/usr/local/bin/telegram-restrict.sh"

# --- Telegram-owned IPv4 ranges only (AS62041 / AS59930 / AS62014) --------
# Deliberately EXCLUDES the Cloudflare/AWS/Fastly/Hetzner/OVH/GCP ranges
# some public lists bundle in "Telegram" IP sheets - those are shared
# cloud-provider blocks used by countless unrelated services, and allowing
# them would defeat a "Telegram only" restriction. Uncomment CDN_RANGES
# below and append it to TELEGRAM_RANGES if you explicitly want to allow
# Telegram's web-preview/CDN-fronted traffic too (much broader exposure).
TELEGRAM_RANGES="
91.105.192.0/23
91.108.4.0/22
91.108.8.0/22
91.108.12.0/22
91.108.16.0/22
91.108.20.0/22
91.108.56.0/22
91.108.58.0/23
95.161.64.0/20
149.154.160.0/20
149.154.162.0/23
149.154.164.0/23
149.154.166.0/23
149.154.168.0/22
149.154.172.0/22
185.76.151.0/24
"
# CDN_RANGES="104.16.0.0/12 172.64.0.0/10 188.114.96.0/22 188.166.0.0/16 3.32.0.0/15 13.248.128.0/18 44.224.0.0/15 52.32.0.0/12 151.101.0.0/16 49.12.0.0/14 95.216.0.0/15 15.204.0.0/15 35.128.0.0/10"

if [ "$ACTION" = "--remove" ]; then
    echo "[*] Removing Telegram-only restriction for $PEER_IP"
    iptables -D FORWARD -s "$PEER_IP" -j "$CHAIN" 2>/dev/null || true
    iptables -F "$CHAIN" 2>/dev/null || true
    iptables -X "$CHAIN" 2>/dev/null || true
    mkdir -p "$RULES_DIR"
    iptables-save > "$RULES_FILE"
    if [ -f "$CONF_PATH" ]; then
        sed -i "\#PostUp = ${SELF_PATH} ${PEER_IP} #d" "$CONF_PATH" 2>/dev/null || true
    fi
    echo "[+] Restriction removed and ruleset re-saved."
    exit 0
fi

echo "[*] Restricting peer $PEER_IP on $IFACE to Telegram IP ranges only"

# --- Build/rebuild a dedicated, idempotent chain for this peer ------------
iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN"

# Allow DNS resolution (needed to resolve Telegram's own endpoints)
iptables -A "$CHAIN" -p udp --dport 53 -j ACCEPT
iptables -A "$CHAIN" -p tcp --dport 53 -j ACCEPT

# Allow Telegram ranges
for net in $TELEGRAM_RANGES; do
    iptables -A "$CHAIN" -d "$net" -j ACCEPT
done

# Drop everything else from this peer
iptables -A "$CHAIN" -j DROP

# --- Hook the peer's forwarded traffic into the chain (top of FORWARD) ----
iptables -D FORWARD -s "$PEER_IP" -j "$CHAIN" 2>/dev/null || true
iptables -I FORWARD 1 -s "$PEER_IP" -j "$CHAIN"

echo "[+] Rules applied. Current chain contents:"
iptables -L "$CHAIN" -v -n

# ============================== PERSISTENCE ================================
# 1) Save the full current ruleset. This is restored automatically if the
#    container has iptables' OpenRC service enabled (rc-update add iptables).
#    Most minimal containers don't run OpenRC, so treat this as a backup you
#    can restore manually with: iptables-restore < /etc/iptables/rules-save
mkdir -p "$RULES_DIR"
iptables-save > "$RULES_FILE"
echo "[+] Ruleset saved to $RULES_FILE"

# 2) The reliable mechanism for THIS setup: hook back into AmneziaWG's own
#    PostUp, so the rule is re-applied every time the interface comes up -
#    which happens automatically whenever the container (re)starts, without
#    depending on OpenRC or any rebuild.
SCRIPT_SRC="$(readlink -f "$0" 2>/dev/null || echo "$0")"
if [ "$SCRIPT_SRC" != "$SELF_PATH" ]; then
    cp "$SCRIPT_SRC" "$SELF_PATH"
    chmod +x "$SELF_PATH"
fi

if [ -f "$CONF_PATH" ]; then
    POSTUP_LINE="PostUp = ${SELF_PATH} ${PEER_IP} ${IFACE} ${CONF_PATH}"
    if ! grep -qF "$POSTUP_LINE" "$CONF_PATH"; then
        sed -i "/^\[Interface\]/a ${POSTUP_LINE}" "$CONF_PATH"
        echo "[+] PostUp hook added to $CONF_PATH"
    else
        echo "[i] PostUp hook already present in $CONF_PATH"
    fi
else
    echo "[!] Config file $CONF_PATH not found - PostUp hook NOT added."
    echo "    The rule is live now, but won't survive a container restart."
    echo "    Re-run with the correct conf path as the 3rd argument."
fi