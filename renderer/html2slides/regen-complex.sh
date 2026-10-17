#!/usr/bin/env bash
# Kept for the npm script, docs and skills; see regen.sh. Usage: ./regen-complex.sh [native|baked]
exec bash "$(dirname "$0")/regen.sh" complex "$@"
