# Shipyard

A self-hosted deployment server with a web UI and MCP server. Two ways to deploy:

- **Web UI** - upload a zip artifact from claude.ai, configure env vars, deploy
- **MCP** - Claude calls the deploy tool directly from claude.ai chat, no zip or upload involved

---

## One-time setup

### 1. Copy to your dev system

```bash
scp -r shipyard-agent/ user@yourserver:~/shipyard-agent
```

### 2. Create the deployments directory

```bash
sudo mkdir -p /opt/shipyard-agent/deployments
sudo chown $USER:$USER /opt/shipyard-agent/deployments
```

### 3. Configure

```bash
cd ~/shipyard-agent
cp .env.example .env
nano .env
```

| Variable | What it is |
|---|---|
| `AGENT_PASSWORD` | Password for the web UI login form |
| `SESSION_SECRET` | Random string - `openssl rand -hex 32` |
| `AGENT_API_KEY` | Key for MCP auth - `openssl rand -hex 32` |
| `NTFY_TOPIC` | Your unique ntfy topic e.g. `alice-deploys-7x3k` |
| `NTFY_URL` | Leave as `https://ntfy.sh` unless self-hosting |
| `DEPLOYMENTS_DIR` | Absolute host path, e.g. `/opt/shipyard-agent/deployments` |
| `PORT` | Web UI port (default `3000`) |

### 4. Install the ntfy app on your phone

Subscribe to the same topic name you set in `NTFY_TOPIC`.

### 5. Start Shipyard

```bash
cd ~/shipyard-agent
docker compose up -d --build
```

Web UI is at `http://your-server-ip:3000`.

To update after changes:

```bash
docker compose up -d --build
```

---

## Using MCP from claude.ai

### Connect the MCP server

In claude.ai - Settings - Integrations - Add MCP server:

```
URL:  http://your-server-ip:3000/mcp/sse?key=YOUR_AGENT_API_KEY
Name: Shipyard
```

### MCP tools available to Claude

| Tool | What it does |
|---|---|
| `deploy_project` | Write all project files and trigger docker compose deploy |
| `list_projects` | List deployed projects and their env var status |
| `update_env` | Update env vars for a project, optionally restart |
| `get_deploy_status` | Check if a specific deploy is running, succeeded, or failed |

### Example prompt

```
Build me a Node.js link shortener with SQLite. Use port 3000.
When you're done, deploy it to my server using the deploy_project tool.
```

Claude will build the project and call `deploy_project` with all the files.
You'll get an ntfy push notification when docker compose finishes.

If any env vars need values (API keys, etc.), Claude will tell you - open
the Shipyard web UI to fill them in.

---

## Using the web UI (zip upload flow)

1. Download your artifact zip from claude.ai
2. Open `http://your-server-ip:3000`
3. Upload the zip - it extracts and detects the project automatically
4. Fill in env vars (pre-populated from `.env.example`)
   - Edit existing values
   - Add new variables with the add variable button
   - Delete variables with the remove button
5. Hit **Save and Deploy** - logs stream live
6. ntfy notifies you on success or failure

---

## Managing projects

From the configure screen of any project you can:

- **Stop** - runs `docker compose down`
- **Start** - runs `docker compose up -d` without rebuilding
- **Save and Deploy** - rebuilds and restarts with the latest files and env vars
- **Remove** - stops containers and deletes all project files

---

## Docker socket note

Shipyard mounts `/var/run/docker.sock` to control the host Docker daemon.
`DEPLOYMENTS_DIR` must be the same absolute path on the host and inside the
container - this ensures relative volume mounts in your artifact's
`docker-compose.yml` resolve correctly on the host.
