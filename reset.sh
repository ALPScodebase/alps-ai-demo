#!/bin/bash

echo "Forcing Docker shutdown and cleanup..."
docker compose -f docker-compose.generated.toxiproxy.yml down # Stop Docker
systemctl --user stop docker
echo "Forcing shutdown of all listeners..."
pkill -f modelCreatorApprove.js
echo "Removing log files..."
rm *.log *.yml
echo "Docker is restarting..."
systemctl --user start docker
echo "Done!"