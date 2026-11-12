#!/bin/sh
# Git asks this helper for a username or a password. The password is not printed by the engine.
case "$1" in
  *sername*) printf '%s\n' 'x-access-token' ;;
  *) printf '%s\n' "${DELIVERY_LOOP_GIT_PASSWORD:-}" ;;
esac
