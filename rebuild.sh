#!/bin/bash
set -e

docker build -t chaiya0899223232/ftrade-mini-bot:latest .
docker push chaiya0899223232/ftrade-mini-bot:latest

echo "Successfully rebuilt and pushed chaiya0899223232/ftrade-mini-bot:latest"
