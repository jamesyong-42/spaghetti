#!/bin/bash
set -e
echo "Running spaghetti type validators..."
echo ""

PASS=0
FAIL=0

echo "=== Session/Message Types ==="
if python3 scripts/validate_sessions_and_messages.py 2>&1 | tail -3; then
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1))
fi

echo ""
echo "=== Config/Settings Types ==="
if python3 scripts/validate_config_and_settings.py 2>&1 | tail -3; then
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1))
fi

echo ""
echo "=== Secondary Data Types ==="
if python3 scripts/validate_secondary_data.py 2>&1 | tail -3; then
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1))
fi

echo ""
echo "=============================="
echo "Validation suites: $PASS passed, $FAIL failed"
if [ $FAIL -gt 0 ]; then
  exit 1
fi
