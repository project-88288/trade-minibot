#!/bin/bash
set -e

docker build -t 88288/ftrade-mini-bot:latest .
docker push 88288/ftrade-mini-bot:latest

echo "Successfully rebuilt and pushed 88288/ftrade-mini-bot:latest"
