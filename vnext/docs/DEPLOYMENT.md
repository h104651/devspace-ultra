# DevSpace Ultra — Zero-Cost Cloud Deployment Guide

## 1. Overview

DevSpace Ultra Gateway can be deployed for **$0 / month** on modern free-tier container and Node.js hosting platforms (Fly.io, Render, Railway, Hugging Face Spaces, or a free VPS).

The Windows Desktop Local Agent and Kaggle GPU Backend connect to this public Gateway over outbound HTTPS / WebSockets.

---

## 2. Option A: Fly.io Deployment (Recommended)

### Dockerfile
```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/
COPY .env.example ./.env
EXPOSE 4000
CMD ["node", "dist/cli/gateway-cli.js"]
```

### Deploying
```bash
fly launch --name devspace-ultra-gateway --port 4000
fly secrets set MASTER_SECRET=$(openssl rand -hex 32)
fly secrets set KAGGLE_USERNAME=your_user KAGGLE_KEY=your_key
fly deploy
```

---

## 3. Option B: Render / Railway (Free Tier)

1. Create a **Web Service** pointing to your GitHub repository.
2. Build Command: `npm install && npm run build`
3. Start Command: `npm run gateway`
4. Set Environment Variables:
   * `PORT`: `4000`
   * `MASTER_SECRET`: `<generated-secret>`
   * `STORAGE_DIR`: `/tmp/devspace-storage` (or persistent volume)
   * `KAGGLE_USERNAME`: `<username>`
   * `KAGGLE_KEY`: `<api_key>`

---

## 4. Option C: Local LAN / Self-Hosted VPS

If you host the gateway on a VPS or local home server:
```bash
npm run gateway
```
Then configure your Local Agent's `GATEWAY_URL` to point to the server's domain or IP:
```env
GATEWAY_URL=wss://gateway.yourdomain.com/ws/agent
```
