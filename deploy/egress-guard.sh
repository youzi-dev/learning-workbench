#!/bin/sh
set -eu
# Namespace initialization only. The downloader joins this namespace as UID
# 10001, with ALL capabilities dropped; it cannot change these rules.
case "$WORKBENCH_PROXY_IP" in
  ''|*[!0-9.]*) exit 2 ;;
esac
iptables -F OUTPUT
iptables -P OUTPUT DROP
iptables -A OUTPUT -d "$WORKBENCH_PROXY_IP" -p tcp --dport 3128 -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -F OUTPUT
ip6tables -P OUTPUT DROP
# Drop the initialization privilege permanently after policy installation.
exec setpriv --reuid=10001 --regid=10001 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all sleep 2147483647
