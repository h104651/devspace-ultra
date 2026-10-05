# DevSpace Ultra Workspace Guidelines

## Project Overview
DevSpace Ultra is a unified remote-to-local agentic execution gateway connecting remote MCP clients (e.g. ChatGPT, Claude, custom agents) with local execution environments and cloud runners (such as Kaggle and Cloudflare Workers).

## Core Principles
1. **Zero Unintended Mutations**: All state changes must strictly follow explicit caller specifications, optimistic concurrency control, and deterministic fail-closed safety checks.
2. **Local Agent Daemon**: The local agent daemon runs in the background and connects outbound to the Cloudflare Gateway via WebSocket.
