#!/bin/bash
# BetterDesk - Local Build & QNAP Deployment Script
set -e

# 1. Build the image locally
echo "🚀 Building image locally..."
docker build -t nas:32768/betterdesk:latest .

# 2. Push to the QNAP registry
echo "📦 Pushing image to QNAP registry..."
docker push nas:32768/betterdesk:latest

# 3. Redeploy on QNAP using the 'qnap' context
echo "🔄 Redeploying on QNAP..."
docker --context qnap compose -f docker-compose.qnap.yml up -d --pull always

echo "✅ Deployment complete!"
