#!/usr/bin/env bash
set -euo pipefail

HOST=${SEM_VPS_HOST:-root@13.140.28.124}
REMOTE_DIR=/opt/sem

tar czf /tmp/sem-deploy.tar.gz \
  --exclude=node_modules --exclude=dist --exclude=data \
  --exclude=.git --exclude=tmp-data \
  -C "$(dirname "$0")/.." .

scp -o StrictHostKeyChecking=accept-new /tmp/sem-deploy.tar.gz "$HOST:/opt/sem-deploy.tar.gz"
ssh -o StrictHostKeyChecking=accept-new "$HOST" "
  mkdir -p $REMOTE_DIR &&
  cd $REMOTE_DIR &&
  tar xzf /opt/sem-deploy.tar.gz &&
  docker compose -f docker-compose.prod.yml up -d --build 2>&1 | tail -5
"
rm -f /tmp/sem-deploy.tar.gz
echo "Deployed: https://sem.aihub.software"
