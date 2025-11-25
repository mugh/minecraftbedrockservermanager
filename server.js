// server.js - Minecraft Bedrock Server Manager Backend

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Docker = require('dockerode');
const fs = require('fs-extra');
const path = require('path');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const fsPromises = require('fs').promises;
const multer = require('multer');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true, // Support older Socket.IO clients
  pingTimeout: 60000,
  pingInterval: 25000
});

// Ensure temp directories exist
async function ensureTempDirs() {
  try {
    await fs.ensureDir('./temp');
    await fs.ensureDir('./temp/addon-uploads');
    await fs.ensureDir('./temp/uploads');
    console.log('Temp directories created/verified');
  } catch (err) {
    console.error('Failed to create temp directories:', err);
  }
}

// Cross-platform Docker configuration with environment variable support
let dockerConfig;
if (process.env.DOCKER_HOST) {
  // Parse DOCKER_HOST (e.g., tcp://host.docker.internal:2375 or unix:///var/run/docker.sock)
  const dockerHost = process.env.DOCKER_HOST;
  if (dockerHost.startsWith('tcp://')) {
    const url = new URL(dockerHost);
    dockerConfig = { host: url.hostname, port: parseInt(url.port) };
  } else if (dockerHost.startsWith('unix://')) {
    dockerConfig = { socketPath: dockerHost.substring(7) };
  } else {
    // Fallback for other formats
    dockerConfig = { socketPath: '/var/run/docker.sock' };
  }
} else {
  // Platform-based defaults
  dockerConfig = process.platform === 'win32'
    ? { host: 'localhost', port: 2375 } // Windows Docker Desktop (ensure TCP is enabled)
    : { socketPath: '/var/run/docker.sock' }; // Linux/Unix socket
}
const docker = new Docker(dockerConfig);

app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Handle preflight OPTIONS requests
app.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
  res.status(200).end();
});

app.use(express.json({ limit: '50mb' })); // Increase JSON payload limit
app.use(express.urlencoded({ limit: '50mb', extended: true })); // Handle URL-encoded data

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Configuration
const DATA_DIR = process.env.DATA_DIR;
const BEDROCK_IMAGE = 'itzg/minecraft-bedrock-server';

// Helper: Get server data path
const getServerPath = (serverId) => path.join(DATA_DIR, serverId);

// Helper: Get host data path by inspecting container mounts
const getHostDataPath = async () => {
  try {
    console.log('Searching for container with /app/minecraft-data mount...');
    // List all containers and find the one with /app/minecraft-data mount
    const containers = await docker.listContainers({ all: true });
    console.log(`Found ${containers.length} containers`);

    let minecraftMount = null;

    for (const c of containers) {
      try {
        console.log(`Inspecting container: ${c.Names[0]} (${c.Id.substring(0,12)})`);
        const container = docker.getContainer(c.Id);
        const containerInfo = await container.inspect();

        console.log(`Container mounts:`, containerInfo.Mounts);

        // Find the mount with target /app/minecraft-data
        const mount = containerInfo.Mounts?.find(m => m.Destination === '/app/minecraft-data');
        if (mount) {
          minecraftMount = mount;
          console.log('Found container with minecraft-data mount:', c.Names[0], mount);
          break;
        }
      } catch (err) {
        console.log(`Failed to inspect container ${c.Names[0]}:`, err.message);
        continue;
      }
    }

    if (!minecraftMount) {
      throw new Error('No container found with /app/minecraft-data mount');
    }

    console.log('Using mount source:', minecraftMount.Source);
    return minecraftMount.Source;
  } catch (err) {
    console.error('Failed to get host data path from container mounts:', err);
    console.log('Falling back to DATA_DIR:', DATA_DIR);
    // For now, still fallback but log it clearly
    return DATA_DIR;
  }
};

// Helper: Get container by server ID
const getContainer = async (serverId) => {
  const containers = await docker.listContainers({ all: true });
  const container = containers.find(c => c.Labels['server-id'] === serverId);
  return container ? docker.getContainer(container.Id) : null;
};


// GET /api/servers - List all servers
app.get('/api/servers', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    const bedrockServers = containers.filter(c =>
      c.Image.includes(BEDROCK_IMAGE) && c.Labels['server-id']
    );

    const servers = await Promise.all(bedrockServers.map(async c => {
      const container = docker.getContainer(c.Id);
      const info = await container.inspect();
      const serverId = c.Labels['server-id'];
      const serverPath = getServerPath(serverId);

      // Get server name and version from metadata or fallback to label
      let serverName = c.Labels['server-name'] || serverId;
      let serverVersion = 'LATEST';
      try {
        const metadataPath = path.join(serverPath, 'metadata.json');
        if (await fs.pathExists(metadataPath)) {
          const metadata = await fs.readJson(metadataPath);
          if (metadata.name) {
            serverName = metadata.name;
          }
          if (metadata.version) {
            serverVersion = metadata.version;
          }
        }
      } catch (err) {
        // Ignore metadata read errors, use fallback
      }

      // Get world size
      let worldSize = '0 MB';
      try {
        const worldPath = path.join(serverPath, 'worlds');
        if (await fs.pathExists(worldPath)) {
          const size = await getDirectorySize(worldPath);
          worldSize = formatBytes(size);
        }
      } catch (err) {}

      // Get player count
      let playerCount = 0;
      if (c.State === 'running') {
        try {
          // Send list command
          const exec = await container.exec({
            Cmd: ['send-command', 'list'],
            AttachStdout: true,
            AttachStderr: true
          });
          await exec.start();
          // Wait a bit
          await new Promise(resolve => setTimeout(resolve, 500));
          // Read logs
          const logs = await container.logs({
            stdout: true,
            stderr: true,
            tail: 20
          });
          const logText = logs.toString();
          const lines = logText.trim().split('\n');
          // Find the last "players online:" line
          let lastIndex = -1;
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('players online:')) {
              lastIndex = i;
            }
          }
          if (lastIndex >= 0) {
            // Count the players
            for (let i = lastIndex + 1; i < lines.length; i++) {
              const line = lines[i].trim();
              if (line.startsWith('[') || line.startsWith('>') || line.includes('AutoCompaction') || line === '') {
                break;
              }
              if (line) {
                playerCount++;
              }
            }
          }
        } catch (err) {
          // Ignore errors
        }
      }

      // Get max players from config
      let maxPlayers = 10;
      try {
        const configPath = path.join(serverPath, 'server.properties');
        if (await fs.pathExists(configPath)) {
          const content = await fs.readFile(configPath, 'utf8');
          const maxPlayersMatch = content.match(/max-players=(\d+)/);
          if (maxPlayersMatch) {
            maxPlayers = parseInt(maxPlayersMatch[1]);
          }
        }
      } catch (err) {}

      return {
        id: serverId,
        name: serverName,
        containerName: (c.Names && c.Names[0]) ? c.Names[0].replace('/', '') : (metadata.containerName || serverId),
        version: serverVersion,
        status: c.State,
        players: playerCount,
        maxPlayers: maxPlayers,
        uptime: info.State.Running ? formatUptime(info.State.StartedAt) : '0h 0m',
        memory: formatBytes(info.HostConfig.Memory || 0),
        cpu: '0%',
        worldSize: worldSize,
        ports: c.Ports,
        webPort: PORT
      };
    }));

    res.json(servers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/import - Import existing server
app.post('/api/servers/import', async (req, res) => {
  try {
    const { containerName } = req.body;
    if (!containerName || !containerName.trim()) {
      return res.status(400).json({ error: 'Container name is required' });
    }

    const trimmedName = containerName.trim();

    // Find the container by name
    const containers = await docker.listContainers({ all: true });
    const containerInfo = containers.find(c => c.Names && c.Names.includes(`/${trimmedName}`));

    if (!containerInfo) {
      return res.status(404).json({ error: 'Container not found' });
    }

    // Check if it's the correct image
    if (!containerInfo.Image.includes(BEDROCK_IMAGE)) {
      return res.status(400).json({ error: 'Container is not a Minecraft Bedrock server' });
    }

    // Inspect the container
    const container = docker.getContainer(containerInfo.Id);
    const details = await container.inspect();

    // Find the data mount
    const dataMount = details.Mounts?.find(m => m.Destination === '/data');
    if (!dataMount) {
      return res.status(400).json({ error: 'Container does not have a /data mount' });
    }

    const sourceDataPath = dataMount.Source;

    // Verify the structure
    const serverPropertiesPath = path.join(sourceDataPath, 'server.properties');
    const worldsPath = path.join(sourceDataPath, 'worlds');

    if (!(await fs.pathExists(serverPropertiesPath))) {
      return res.status(400).json({ error: 'Invalid server structure: server.properties not found' });
    }

    if (!(await fs.pathExists(worldsPath))) {
      return res.status(400).json({ error: 'Invalid server structure: worlds directory not found' });
    }

    // Get server name and version from the source
    let serverName = details.Config.Env?.find(env => env.startsWith('SERVER_NAME='))?.split('=')[1] || trimmedName;
    let serverVersion = details.Config.Env?.find(env => env.startsWith('VERSION='))?.split('=')[1] || 'LATEST';

    // Create new server
    const serverId = `bedrock-${Date.now()}`;
    const serverPath = getServerPath(serverId);
    const hostDataPath = await getHostDataPath();
    const hostServerPath = path.join(hostDataPath, serverId);

    // Create server directory
    await fs.ensureDir(serverPath);

    // Stop the original container before copying data
    console.log(`Stopping original container: ${trimmedName}`);
    try {
      if (details.State.Status === 'running') {
        await container.stop();
        console.log(`Stopped container: ${trimmedName}`);
      }
    } catch (stopErr) {
      console.warn(`Failed to stop container ${trimmedName}:`, stopErr.message);
      // Continue anyway
    }

    // Copy data from source to new server folder
    console.log(`Copying data from ${sourceDataPath} to ${serverPath}`);
    await fs.copy(sourceDataPath, serverPath, { overwrite: true });

    // Update metadata
    const metadataPath = path.join(serverPath, 'metadata.json');
    let metadata = {};
    if (await fs.pathExists(metadataPath)) {
      metadata = await fs.readJson(metadataPath);
    }
    metadata.name = serverName;
    metadata.version = serverVersion;
    metadata.memory = details.HostConfig.Memory || 2 * 1024 * 1024 * 1024; // default 2GB
    metadata.createdAt = new Date().toISOString();
    metadata.updatedAt = new Date().toISOString();
    metadata.importedFrom = trimmedName;
    await fs.writeJson(metadataPath, metadata, { spaces: 2 });

    // Find available port
    const gamePort = await findAvailablePort(19132);

    // Pull the Docker image if not available
    try {
      console.log(`Pulling Docker image: ${BEDROCK_IMAGE}`);
      const stream = await docker.pull(BEDROCK_IMAGE);
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(stream, (err, output) => {
          if (err) reject(err);
          else resolve(output);
        });
      });
      console.log(`Successfully pulled image: ${BEDROCK_IMAGE}`);
    } catch (pullErr) {
      console.error('Failed to pull Docker image:', pullErr);
      // Continue anyway
    }

    // Create new container
    const newContainer = await docker.createContainer({
      Image: BEDROCK_IMAGE,
      name: serverId,
      Labels: {
        'server-id': serverId,
        'server-name': serverName
      },
      Env: [
        'EULA=TRUE',
        'VERSION=' + serverVersion,
        'SERVER_NAME=' + serverName
      ],
      HostConfig: {
        Binds: [`${hostServerPath}:/data`],
        PortBindings: {
          '19132/udp': [{ HostPort: gamePort.toString() }]
        },
        RestartPolicy: {
          Name: 'unless-stopped'
        },
        Memory: metadata.memory
      }
    });

    // Start the new container
    await newContainer.start();

    // Update metadata with actual container name
    const newContainerInfo = await newContainer.inspect();
    const actualContainerName = newContainerInfo.Name ? newContainerInfo.Name.replace('/', '') : serverId;
    const metadataPath3 = path.join(serverPath, 'metadata.json');
    if (await fs.pathExists(metadataPath3)) {
      const metadata = await fs.readJson(metadataPath3);
      metadata.containerName = actualContainerName;
      metadata.updatedAt = new Date().toISOString();
      await fs.writeJson(metadataPath3, metadata, { spaces: 2 });
    }

    // Broadcast server update
    setTimeout(() => broadcastServerUpdate(serverId), 2000);

    res.json({
      id: serverId,
      name: serverName,
      version: serverVersion,
      gamePort,
      message: 'Server imported successfully'
    });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers - Create new server
app.post('/api/servers', async (req, res) => {
  try {
    const { name, version = 'LATEST' } = req.body;
    const serverId = `bedrock-${Date.now()}`;
    const serverPath = getServerPath(serverId);
    const hostDataPath = await getHostDataPath();
    const hostServerPath = path.join(hostDataPath, serverId);

    // Create server directory
    await fs.ensureDir(serverPath);

    // Create metadata file
    const metadataPath = path.join(serverPath, 'metadata.json');
    const metadata = {
      name: name,
      version: version,
      memory: 2 * 1024 * 1024 * 1024, // 2GB default
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await fs.writeJson(metadataPath, metadata, { spaces: 2 });

    // Find available port
    const gamePort = await findAvailablePort(19132);

    // Pull the Docker image if not available
    try {
      console.log(`Pulling Docker image: ${BEDROCK_IMAGE}`);
      const stream = await docker.pull(BEDROCK_IMAGE);
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(stream, (err, output) => {
          if (err) reject(err);
          else resolve(output);
        });
      });
      console.log(`Successfully pulled image: ${BEDROCK_IMAGE}`);
    } catch (pullErr) {
      console.error('Failed to pull Docker image:', pullErr);
      // Continue anyway, as the image might already exist or pull might fail but image is available
    }

    // Create container
    const container = await docker.createContainer({
      Image: BEDROCK_IMAGE,
      name: serverId,
      Labels: {
        'server-id': serverId,
        'server-name': name
      },
      Env: [
        'EULA=TRUE',
        'VERSION=' + version,
        'SERVER_NAME=' + name
      ],
      HostConfig: {
        Binds: [`${hostServerPath}:/data`],
        PortBindings: {
          '19132/udp': [{ HostPort: gamePort.toString() }]
        },
        RestartPolicy: {
          Name: 'unless-stopped'
        },
        Memory: metadata.memory
      }
    });

    await container.start();

    // Update metadata with actual container name
    const containerInfo = await container.inspect();
    const actualContainerName = containerInfo.Name ? containerInfo.Name.replace('/', '') : serverId;
    const metadataPath2 = path.join(serverPath, 'metadata.json');
    if (await fs.pathExists(metadataPath2)) {
      const metadata = await fs.readJson(metadataPath2);
      metadata.containerName = actualContainerName;
      metadata.updatedAt = new Date().toISOString();
      await fs.writeJson(metadataPath2, metadata, { spaces: 2 });
    }

    // Broadcast server update
    setTimeout(() => broadcastServerUpdate(serverId), 2000); // Wait for container to fully start

    res.json({
      id: serverId,
      name,
      version,
      gamePort,
      message: 'Server created successfully'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/start - Start server
app.post('/api/servers/:id/start', async (req, res) => {
  try {
    const container = await getContainer(req.params.id);
    if (!container) return res.status(404).json({ error: 'Server not found' });

    // Try to start the container first
    try {
      await container.start();

      // Update metadata with actual container name
      const serverPath = getServerPath(req.params.id);
      const metadataPath = path.join(serverPath, 'metadata.json');
      if (await fs.pathExists(metadataPath)) {
        const metadata = await fs.readJson(metadataPath);
        const containerInfo = await container.inspect();
        const containerName = containerInfo.Name ? containerInfo.Name.replace('/', '') : req.params.id;
        metadata.containerName = containerName;
        metadata.updatedAt = new Date().toISOString();
        await fs.writeJson(metadataPath, metadata, { spaces: 2 });
      }

      // Broadcast server update
      setTimeout(() => broadcastServerUpdate(req.params.id), 2000);
      res.json({ message: 'Server started' });
    } catch (startErr) {
      // Check if it's a port conflict error
      const errorMessage = startErr.message || '';
      if (errorMessage.includes('port is already allocated') || errorMessage.includes('Bind for') || errorMessage.includes('failed programming external connectivity')) {
        // Get container info
        const containerInfo = await container.inspect();

        // Find new available port
        const newGamePort = await findAvailablePort(19132);

        // Stop container if running (shouldn't be, but just in case)
        if (containerInfo.State.Running) {
          await container.stop();
        }

        // Remove old container
        await container.remove();

        // Create new container with updated port
        const serverId = req.params.id;
        const serverPath = getServerPath(serverId);
        const hostDataPath = await getHostDataPath();
        const hostServerPath = path.join(hostDataPath, serverId);

        // Read metadata for server info
        const metadataPath = path.join(serverPath, 'metadata.json');
        let metadata = {};
        if (await fs.pathExists(metadataPath)) {
          metadata = await fs.readJson(metadataPath);
        }

        // Get memory from metadata
        let memory = metadata.memory || 2 * 1024 * 1024 * 1024; // default 2GB

        const newContainer = await docker.createContainer({
          Image: BEDROCK_IMAGE,
          name: serverId,
          Labels: {
            'server-id': serverId,
            'server-name': metadata.name || serverId
          },
          Env: [
            'EULA=TRUE',
            'VERSION=' + (metadata.version || 'LATEST'),
            'SERVER_NAME=' + (metadata.name || serverId)
          ],
          HostConfig: {
            Binds: [`${hostServerPath}:/data`],
            PortBindings: {
              '19132/udp': [{ HostPort: newGamePort.toString() }]
            },
            RestartPolicy: {
              Name: 'unless-stopped'
            },
            Memory: memory
          }
        });

        // Start the new container
        await newContainer.start();

        // Update metadata with actual container name
        const metadataPath2 = path.join(serverPath, 'metadata.json');
        if (await fs.pathExists(metadataPath2)) {
          const metadata = await fs.readJson(metadataPath2);
          const newContainerInfo = await newContainer.inspect();
          const containerName = newContainerInfo.Name ? newContainerInfo.Name.replace('/', '') : serverId;
          metadata.containerName = containerName;
          metadata.updatedAt = new Date().toISOString();
          await fs.writeJson(metadataPath2, metadata, { spaces: 2 });
        }

        res.json({
          message: 'Server started with updated port due to port conflict',
          gamePort: newGamePort,
          portsUpdated: true
        });
      } else {
        // Re-throw non-port related errors
        throw startErr;
      }
    }
  } catch (err) {
    console.error('Error starting server:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/stop - Stop server
app.post('/api/servers/:id/stop', async (req, res) => {
  try {
    const container = await getContainer(req.params.id);
    if (!container) return res.status(404).json({ error: 'Server not found' });

    await container.stop();
    // Broadcast server update
    setTimeout(() => broadcastServerUpdate(req.params.id), 1000);
    res.json({ message: 'Server stopped' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/restart - Restart server
app.post('/api/servers/:id/restart', async (req, res) => {
  try {
    const container = await getContainer(req.params.id);
    if (!container) return res.status(404).json({ error: 'Server not found' });

    await container.restart();
    // Broadcast server update
    setTimeout(() => broadcastServerUpdate(req.params.id), 3000);
    res.json({ message: 'Server restarted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/rename - Rename server
app.post('/api/servers/:id/rename', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Server name is required' });
    }

    const serverId = req.params.id;
    const serverPath = getServerPath(serverId);
    const metadataPath = path.join(serverPath, 'metadata.json');

    // Ensure server directory exists
    if (!await fs.pathExists(serverPath)) {
      return res.status(404).json({ error: 'Server not found' });
    }

    // Read or create metadata
    let metadata = {};
    if (await fs.pathExists(metadataPath)) {
      metadata = await fs.readJson(metadataPath);
    }

    // Update the name
    metadata.name = name.trim();
    metadata.updatedAt = new Date().toISOString();

    // Save metadata
    await fs.writeJson(metadataPath, metadata, { spaces: 2 });

    // Broadcast server list update to all connected clients
    broadcastServerUpdate();

    // Get current container info
    const container = await getContainer(serverId);
    if (!container) {
      return res.status(404).json({ error: 'Container not found' });
    }

    const containerInfo = await container.inspect();
    const wasRunning = containerInfo.State.Running;

    // Stop container if running
    if (wasRunning) {
      await container.stop();
    }

    // Remove container
    await container.remove();

    // Find available port (reuse existing if possible)
    const gamePort = containerInfo.HostConfig.PortBindings['19132/udp']?.[0]?.HostPort || await findAvailablePort(19132);

    // Get memory from metadata
    let memory = metadata.memory || 2 * 1024 * 1024 * 1024; // default 2GB

    const hostDataPath = await getHostDataPath();
    const hostServerPath = path.join(hostDataPath, serverId);

    // Pull the Docker image if not available
    try {
      console.log(`Pulling Docker image: ${BEDROCK_IMAGE}`);
      const stream = await docker.pull(BEDROCK_IMAGE);
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(stream, (err, output) => {
          if (err) reject(err);
          else resolve(output);
        });
      });
      console.log(`Successfully pulled image: ${BEDROCK_IMAGE}`);
    } catch (pullErr) {
      console.error('Failed to pull Docker image:', pullErr);
      // Continue anyway, as the image might already exist or pull might fail but image is available
    }

    // Create new container with updated server name
    const newContainer = await docker.createContainer({
      Image: BEDROCK_IMAGE,
      name: serverId,
      Labels: {
        'server-id': serverId,
        'server-name': name.trim()
      },
      Env: [
        'EULA=TRUE',
        'VERSION=' + (metadata.version || 'LATEST'),
        'SERVER_NAME=' + name.trim()
      ],
      HostConfig: {
        Binds: [`${hostServerPath}:/data`],
        PortBindings: {
          '19132/udp': [{ HostPort: gamePort.toString() }]
        },
        RestartPolicy: {
          Name: 'unless-stopped'
        },
        Memory: memory
      }
    });

    // Start container if it was running before
    if (wasRunning) {
      await newContainer.start();
    }

    // Update metadata with actual container name
    const newContainerInfo = await newContainer.inspect();
    const actualContainerName = newContainerInfo.Name ? newContainerInfo.Name.replace('/', '') : serverId;
    const metadataPath4 = path.join(serverPath, 'metadata.json');
    if (await fs.pathExists(metadataPath4)) {
      const metadata = await fs.readJson(metadataPath4);
      metadata.containerName = actualContainerName;
      metadata.updatedAt = new Date().toISOString();
      await fs.writeJson(metadataPath4, metadata, { spaces: 2 });
    }

    // Broadcast server update
    setTimeout(() => broadcastServerUpdate(serverId), wasRunning ? 3000 : 1000);

    res.json({
      message: 'Server renamed successfully',
      name: name.trim(),
      restarted: wasRunning
    });
  } catch (err) {
    console.error('Error renaming server:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/version - Update server version
app.post('/api/servers/:id/version', async (req, res) => {
  try {
    const { version } = req.body;
    if (!version || !version.trim()) {
      return res.status(400).json({ error: 'Version is required' });
    }

    const serverId = req.params.id;
    const serverPath = getServerPath(serverId);
    const metadataPath = path.join(serverPath, 'metadata.json');

    // Ensure server directory exists
    if (!await fs.pathExists(serverPath)) {
      return res.status(404).json({ error: 'Server not found' });
    }

    // Get current container info
    const container = await getContainer(serverId);
    if (!container) {
      return res.status(404).json({ error: 'Container not found' });
    }

    const containerInfo = await container.inspect();
    const wasRunning = containerInfo.State.Running;

    // Stop container if running
    if (wasRunning) {
      await container.stop();
    }

    // Remove container
    await container.remove();

    // Update metadata
    let metadata = {};
    if (await fs.pathExists(metadataPath)) {
      metadata = await fs.readJson(metadataPath);
    }
    metadata.version = version.trim();
    metadata.updatedAt = new Date().toISOString();
    await fs.writeJson(metadataPath, metadata, { spaces: 2 });

    // Get memory from metadata
    let memory = metadata.memory || 2 * 1024 * 1024 * 1024; // default 2GB

    // Find available port (reuse existing if possible)
    const gamePort = containerInfo.HostConfig.PortBindings['19132/udp']?.[0]?.HostPort || await findAvailablePort(19132);

    const hostDataPath = await getHostDataPath();
    const hostServerPath = path.join(hostDataPath, serverId);

    // Create new container with updated version
    const newContainer = await docker.createContainer({
      Image: BEDROCK_IMAGE,
      name: serverId,
      Labels: {
        'server-id': serverId,
        'server-name': metadata.name
      },
      Env: [
        'EULA=TRUE',
        'VERSION=' + version.trim(),
        'SERVER_NAME=' + metadata.name
      ],
      HostConfig: {
        Binds: [`${hostServerPath}:/data`],
        PortBindings: {
          '19132/udp': [{ HostPort: gamePort.toString() }]
        },
        RestartPolicy: {
          Name: 'unless-stopped'
        },
        Memory: memory
      }
    });

    // Start container if it was running before
    if (wasRunning) {
      await newContainer.start();
    }

    // Update metadata with actual container name
    const newContainerInfo = await newContainer.inspect();
    const actualContainerName = newContainerInfo.Name ? newContainerInfo.Name.replace('/', '') : serverId;
    const metadataPath5 = path.join(serverPath, 'metadata.json');
    if (await fs.pathExists(metadataPath5)) {
      const metadata = await fs.readJson(metadataPath5);
      metadata.containerName = actualContainerName;
      metadata.updatedAt = new Date().toISOString();
      await fs.writeJson(metadataPath5, metadata, { spaces: 2 });
    }

    // Broadcast server update
    setTimeout(() => broadcastServerUpdate(serverId), wasRunning ? 5000 : 1000); // Longer wait for version updates

    res.json({
      message: 'Server version updated successfully',
      version: version.trim(),
      restarted: wasRunning
    });
  } catch (err) {
    console.error('Error updating server version:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/servers/:id/memory - Update server memory
app.put('/api/servers/:id/memory', async (req, res) => {
  try {
    const { memory } = req.body; // memory in MB
    if (!memory || memory < 256 || memory > 32768) {
      return res.status(400).json({ error: 'Memory must be between 256MB and 32768MB' });
    }

    const memoryBytes = memory * 1024 * 1024;
    const serverId = req.params.id;
    const serverPath = getServerPath(serverId);
    const metadataPath = path.join(serverPath, 'metadata.json');

    // Ensure server directory exists
    if (!await fs.pathExists(serverPath)) {
      return res.status(404).json({ error: 'Server not found' });
    }

    // Get container
    const container = await getContainer(serverId);
    if (!container) {
      return res.status(404).json({ error: 'Container not found' });
    }

    const containerInfo = await container.inspect();
    const wasRunning = containerInfo.State.Running;

    // Stop container if running
    if (wasRunning) {
      await container.stop();
    }

    // Remove container
    await container.remove();

    // Update metadata
    let metadata = {};
    if (await fs.pathExists(metadataPath)) {
      metadata = await fs.readJson(metadataPath);
    }
    metadata.memory = memoryBytes;
    metadata.updatedAt = new Date().toISOString();
    await fs.writeJson(metadataPath, metadata, { spaces: 2 });

    // Find available port (reuse existing if possible)
    const gamePort = containerInfo.HostConfig.PortBindings['19132/udp']?.[0]?.HostPort || await findAvailablePort(19132);

    const hostDataPath = await getHostDataPath();
    const hostServerPath = path.join(hostDataPath, serverId);

    // Pull the Docker image if not available
    try {
      console.log(`Pulling Docker image: ${BEDROCK_IMAGE}`);
      const stream = await docker.pull(BEDROCK_IMAGE);
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(stream, (err, output) => {
          if (err) reject(err);
          else resolve(output);
        });
      });
      console.log(`Successfully pulled image: ${BEDROCK_IMAGE}`);
    } catch (pullErr) {
      console.error('Failed to pull Docker image:', pullErr);
      // Continue anyway, as the image might already exist or pull might fail but image is available
    }

    // Create new container with updated memory
    const newContainer = await docker.createContainer({
      Image: BEDROCK_IMAGE,
      name: serverId,
      Labels: {
        'server-id': serverId,
        'server-name': metadata.name
      },
      Env: [
        'EULA=TRUE',
        'VERSION=' + (metadata.version || 'LATEST'),
        'SERVER_NAME=' + metadata.name
      ],
      HostConfig: {
        Binds: [`${hostServerPath}:/data`],
        PortBindings: {
          '19132/udp': [{ HostPort: gamePort.toString() }]
        },
        RestartPolicy: {
          Name: 'unless-stopped'
        },
        Memory: memoryBytes
      }
    });

    // Start container if it was running before
    if (wasRunning) {
      await newContainer.start();
    }

    // Update metadata with actual container name
    const newContainerInfo = await newContainer.inspect();
    const actualContainerName = newContainerInfo.Name ? newContainerInfo.Name.replace('/', '') : serverId;
    const metadataPath6 = path.join(serverPath, 'metadata.json');
    if (await fs.pathExists(metadataPath6)) {
      const metadata = await fs.readJson(metadataPath6);
      metadata.containerName = actualContainerName;
      metadata.updatedAt = new Date().toISOString();
      await fs.writeJson(metadataPath6, metadata, { spaces: 2 });
    }

    // Broadcast server update
    setTimeout(() => broadcastServerUpdate(serverId), wasRunning ? 5000 : 1000);

    res.json({
      message: 'Server memory updated successfully',
      memory: memory,
      memoryBytes: memoryBytes,
      restarted: wasRunning
    });
  } catch (err) {
    console.error('Error updating server memory:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE/POST /api/servers/:id/delete - Delete server
app.delete('/api/servers/:id/delete', async (req, res) => {
  await handleDeleteServer(req, res);
});

// For backward compatibility, also support POST
app.post('/api/servers/:id/delete', async (req, res) => {
  await handleDeleteServer(req, res);
});

async function handleDeleteServer(req, res) {
  try {
    const container = await getContainer(req.params.id);
    if (container) {
      try {
        // Try to stop the container if it's running
        const containerInfo = await container.inspect();
        if (containerInfo.State.Running) {
          await container.stop();
        }
        await container.remove();
      } catch (err) {
        // If container is already stopped, just remove it
        if (err.statusCode === 304 || err.message.includes('already in progress') || err.message.includes('already stopped')) {
          await container.remove();
        } else {
          throw err;
        }
      }
    }
    
    const serverPath = getServerPath(req.params.id);
    await fs.remove(serverPath);

    // Broadcast server update (server list changed)
    setTimeout(() => broadcastServerUpdate(), 1000);

    res.json({ message: 'Server deleted' });
  } catch (err) {
    console.error('Error in handleDeleteServer:', err);
    res.status(500).json({ 
      error: 'Failed to delete server',
      details: err.message 
    });
  }
}

// GET /api/servers/:id/logs - Get server logs
app.get('/api/servers/:id/logs', async (req, res) => {
  try {
    const container = await getContainer(req.params.id);
    if (!container) return res.status(404).json({ error: 'Server not found' });
    
    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail: 100
    });
    
    const logLines = logs.toString().split('\n').filter(l => l.trim());
    res.json(logLines);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/command - Execute server command
app.post('/api/servers/:id/command', async (req, res) => {
  try {
    const { command } = req.body;
    const container = await getContainer(req.params.id);
    if (!container) return res.status(404).json({ error: 'Server not found' });
    
    // Use send-command script bundled with itzg/minecraft-bedrock-server
    const exec = await container.exec({
      Cmd: ['send-command', ...command.split(' ')],
      AttachStdout: true,
      AttachStderr: true
    });
    
    const stream = await exec.start();
    
    let output = '';
    stream.on('data', (chunk) => {
      output += chunk.toString();
    });
    
    await new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    // Broadcast server details update (logs may have changed)
    setTimeout(() => broadcastServerDetails(req.params.id), 1000);

    res.json({
      response: output || 'Command sent successfully. Check server logs for output.',
      message: 'Command executed via send-command script'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/servers/:id/players - Get player list using list command and logs
app.get('/api/servers/:id/players', async (req, res) => {
  try {
    const container = await getContainer(req.params.id);
    if (!container) return res.status(404).json({ error: 'Server not found' });

    // Check if container is running
    const containerInfo = await container.inspect();
    if (containerInfo.State.Status !== 'running') {
      return res.json([]);
    }

    let logs;
    try {
      // Send list command
      const exec = await container.exec({
        Cmd: ['send-command', 'list'],
        AttachStdout: true,
        AttachStderr: true
      });

      await exec.start();

      // Wait a bit for the command to execute
      await new Promise(resolve => setTimeout(resolve, 500));

      // Read recent logs to get the list output
      logs = await container.logs({
        stdout: true,
        stderr: true,
        tail: 20
      });
    } catch (err) {
      // If container operations fail (e.g., container stopped), return empty list
      return res.json([]);
    }

    const logText = logs.toString();

    const lines = logText.trim().split('\n');
    const players = [];

    // Find the LAST line with player list from the command output (most recent)
    let lastIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('players online:')) {
        lastIndex = i;
      }
    }

    if (lastIndex >= 0) {
      // Parse players from the last list output
      for (let i = lastIndex + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        // Stop if it's a log line (starts with [ or >) or other messages
        if (line.startsWith('[') || line.startsWith('>') || line.includes('AutoCompaction') || line === '') {
          break;
        }
        if (line) {
          // Split by comma and clean each name
          const names = line.split(',').map(n => n.replace(/[^\x20-\x7E]/g, '').trim()).filter(n => n);
          players.push(...names.map(name => ({ name })));
        }
      }
    }

    // Load player cache
    let playerCache = {};
    const cachePath = path.join(getServerPath(req.params.id), 'player_cache.json');
    try {
      if (await fs.pathExists(cachePath)) {
        const cacheContent = await fs.readFile(cachePath, 'utf8');
        playerCache = JSON.parse(cacheContent);
      }
    } catch (err) {
      // Ignore
    }

    // Get XUID for each player from cache or external API
    for (const player of players) {
      if (playerCache[player.name]) {
        player.xuid = playerCache[player.name];
      } else {
        try {
          const response = await fetch(`https://mcprofile.io/api/v1/bedrock/gamertag/${encodeURIComponent(player.name)}`);
          if (response.ok) {
            const data = await response.json();
            player.xuid = data.xuid || null;
            playerCache[player.name] = player.xuid;
          } else {
            player.xuid = null;
          }
        } catch (err) {
          player.xuid = null;
        }
        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Save updated cache
    try {
      await fs.writeJson(cachePath, playerCache, { spaces: 2 });
    } catch (err) {
      // Ignore
    }

    // Check operators from permissions.json
    let permissions = [];
    try {
      const permissionsPath = path.join(getServerPath(req.params.id), 'permissions.json');
      if (await fs.pathExists(permissionsPath)) {
        const permissionsContent = await fs.readFile(permissionsPath, 'utf8');
        permissions = JSON.parse(permissionsContent);
      }
    } catch (err) {
      // Ignore
    }

    // Mark operators
    const operatorXuids = permissions.filter(p => p.permission === 'operator').map(p => p.xuid);
    players.forEach(player => {
      player.isOperator = player.xuid && operatorXuids.includes(player.xuid);
    });

    // Update the player count in the servers list for the sidebar
    // But since we can't modify state here, the frontend will handle it

    res.json(players);
  } catch (err) {
    console.error('Error getting players:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/players/:playerName/kick - Kick player
app.post('/api/servers/:id/players/:playerName/kick', async (req, res) => {
  try {
    const { playerName } = req.params;
    const { reason } = req.body;
    const container = await getContainer(req.params.id);
    if (!container) return res.status(404).json({ error: 'Server not found' });
    
    const command = reason ? `kick "${playerName}" ${reason}` : `kick "${playerName}"`;
    const exec = await container.exec({
      Cmd: ['send-command', ...command.split(' ')],
      AttachStdout: true,
      AttachStderr: true
    });
    
    await exec.start();
    // Broadcast server details update (players may have changed)
    setTimeout(() => broadcastServerDetails(req.params.id), 1000);
    res.json({ message: `Player ${playerName} kicked` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/players/:playerName/ban - Ban player
app.post('/api/servers/:id/players/:playerName/ban', async (req, res) => {
  try {
    const { playerName } = req.params;
    const { reason } = req.body;
    const container = await getContainer(req.params.id);
    if (!container) return res.status(404).json({ error: 'Server not found' });
    
    const command = reason ? `ban "${playerName}" ${reason}` : `ban "${playerName}"`;
    const exec = await container.exec({
      Cmd: ['send-command', ...command.split(' ')],
      AttachStdout: true,
      AttachStderr: true
    });
    
    await exec.start();
    // Broadcast server details update (players may have changed)
    setTimeout(() => broadcastServerDetails(req.params.id), 1000);
    res.json({ message: `Player ${playerName} banned` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/players/:playerName/op - Make player operator
app.post('/api/servers/:id/players/:playerName/op', async (req, res) => {
  try {
    const { playerName } = req.params;
    const container = await getContainer(req.params.id);
    if (!container) return res.status(404).json({ error: 'Server not found' });
    
    const exec = await container.exec({
      Cmd: ['send-command', 'op', playerName],
      AttachStdout: true,
      AttachStderr: true
    });
    
    await exec.start();
    // Broadcast server details update (player permissions changed)
    setTimeout(() => broadcastServerDetails(req.params.id), 1000);
    res.json({ message: `Player ${playerName} is now an operator` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/players/:playerName/deop - Remove operator status
app.post('/api/servers/:id/players/:playerName/deop', async (req, res) => {
  try {
    const { playerName } = req.params;
    const container = await getContainer(req.params.id);
    if (!container) return res.status(404).json({ error: 'Server not found' });
    
    const exec = await container.exec({
      Cmd: ['send-command', 'deop', playerName],
      AttachStdout: true,
      AttachStderr: true
    });
    
    await exec.start();
    // Broadcast server details update (player permissions changed)
    setTimeout(() => broadcastServerDetails(req.params.id), 1000);
    res.json({ message: `Player ${playerName} is no longer an operator` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/servers/:id/files - List files
app.get('/api/servers/:id/files', async (req, res) => {
  try {
    const serverPath = getServerPath(req.params.id);
    const requestedPath = req.query.path || '/';
    const fullPath = path.join(serverPath, requestedPath);
    
    // Security: prevent path traversal
    if (!fullPath.startsWith(serverPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    if (!await fs.pathExists(fullPath)) {
      return res.json([]);
    }
    
    const items = await fs.readdir(fullPath);
    const files = await Promise.all(items.map(async item => {
      const itemPath = path.join(fullPath, item);
      const stats = await fs.stat(itemPath);
      return {
        name: item,
        path: path.join(requestedPath, item),
        type: stats.isDirectory() ? 'directory' : 'file',
        size: stats.isFile() ? formatBytes(stats.size) : '-',
        modified: stats.mtime
      };
    }));
    
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/servers/:id/files/download - Download file
app.get('/api/servers/:id/files/download', async (req, res) => {
  try {
    const serverPath = getServerPath(req.params.id);
    const filePath = path.join(serverPath, req.query.path);
    
    if (!filePath.startsWith(serverPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    if (!await fs.pathExists(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    res.download(filePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/servers/:id/files - Delete file
app.delete('/api/servers/:id/files', async (req, res) => {
  try {
    const serverPath = getServerPath(req.params.id);
    const filePath = path.join(serverPath, req.query.path);
    
    if (!filePath.startsWith(serverPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    await fs.remove(filePath);
    res.json({ message: 'File deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/files/upload - Upload files
const upload = multer({ dest: './temp/uploads/' });

app.post('/api/servers/:id/files/upload', upload.array('files'), async (req, res) => {
  try {
    const serverPath = getServerPath(req.params.id);
    const targetPath = path.join(serverPath, req.query.path || '/');
    
    if (!targetPath.startsWith(serverPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    await fs.ensureDir(targetPath);
    
    for (const file of req.files) {
      const destPath = path.join(targetPath, file.originalname);
      await fs.move(file.path, destPath, { overwrite: true });
    }
    
    res.json({ message: 'Files uploaded successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/files/rename - Rename file
app.post('/api/servers/:id/files/rename', async (req, res) => {
  try {
    const { oldPath, newName } = req.body;
    const serverPath = getServerPath(req.params.id);
    const oldFullPath = path.join(serverPath, oldPath);
    const newFullPath = path.join(path.dirname(oldFullPath), newName);
    
    if (!oldFullPath.startsWith(serverPath) || !newFullPath.startsWith(serverPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    await fs.move(oldFullPath, newFullPath);
    res.json({ message: 'File renamed successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/servers/:id/files/content - Get file content
app.get('/api/servers/:id/files/content', async (req, res) => {
  try {
    const serverPath = getServerPath(req.params.id);
    const filePath = path.join(serverPath, req.query.path);
    
    if (!filePath.startsWith(serverPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const content = await fs.readFile(filePath, 'utf8');
    res.send(content);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/servers/:id/files/content - Update file content
app.put('/api/servers/:id/files/content', async (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    const serverPath = getServerPath(req.params.id);
    const fullPath = path.join(serverPath, filePath);
    
    if (!fullPath.startsWith(serverPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    await fs.writeFile(fullPath, content, 'utf8');
    res.json({ message: 'File saved successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/files/folder - Create new folder
app.post('/api/servers/:id/files/folder', async (req, res) => {
  try {
    const { path: folderPath, name } = req.body;
    const serverPath = getServerPath(req.params.id);
    const fullPath = path.join(serverPath, folderPath, name);
    
    if (!fullPath.startsWith(serverPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    await fs.ensureDir(fullPath);
    res.json({ message: 'Folder created successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/servers/:id/backups - List backups
app.get('/api/servers/:id/backups', async (req, res) => {
  try {
    const serverPath = getServerPath(req.params.id);
    const backupPath = path.join(serverPath, 'backups');
    
    await fs.ensureDir(backupPath);
    
    const backups = await fs.readdir(backupPath);
    const backupList = await Promise.all(backups.map(async file => {
      const filePath = path.join(backupPath, file);
      const stats = await fs.stat(filePath);
      return {
        id: file.replace('.zip', ''),
        name: file,
        path: filePath,
        date: stats.mtime.toLocaleString(),
        size: formatBytes(stats.size)
      };
    }));
    
    res.json(backupList.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/backups - Create backup
app.post('/api/servers/:id/backups', async (req, res) => {
  try {
    const serverPath = getServerPath(req.params.id);
    const backupPath = path.join(serverPath, 'backups');
    const worldPath = path.join(serverPath, 'worlds');
    
    await fs.ensureDir(backupPath);
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(backupPath, `backup-${timestamp}.zip`);
    
    const output = fs.createWriteStream(backupFile);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    output.on('close', () => {
      res.json({ 
        message: 'Backup created', 
        file: `backup-${timestamp}.zip`,
        size: formatBytes(archive.pointer())
      });
    });
    
    archive.on('error', (err) => {
      throw err;
    });
    
    archive.pipe(output);
    archive.directory(worldPath, 'worlds');
    archive.file(path.join(serverPath, 'server.properties'), { name: 'server.properties' });
    await archive.finalize();
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/zip - Zip files/folders
app.post('/api/servers/:id/zip', express.json(), async (req, res) => {
  try {
    const { sourcePath, zipName } = req.body;
    const serverPath = getServerPath(req.params.id);
    const fullSourcePath = path.join(serverPath, sourcePath);
    const zipPath = path.join(serverPath, zipName);

    // Check if source exists
    if (!(await fs.pathExists(fullSourcePath))) {
      return res.status(404).json({ error: 'Source path not found' });
    }

    // Create a file to stream archive data to
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    });

    output.on('close', () => {
      res.json({ 
        message: 'Archive created successfully',
        zipName: path.basename(zipPath),
        size: archive.pointer()
      });
    });

    archive.on('error', (err) => {
      throw err;
    });

    // Pipe archive data to the file
    archive.pipe(output);

    // Append files/directories to the archive
    const stats = await fs.lstat(fullSourcePath);
    if (stats.isDirectory()) {
      archive.directory(fullSourcePath, path.basename(fullSourcePath));
    } else {
      archive.file(fullSourcePath, { name: path.basename(fullSourcePath) });
    }

    // Finalize the archive
    await archive.finalize();

  } catch (err) {
    console.error('Zip error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/unzip - Unzip file
app.post('/api/servers/:id/unzip', express.json(), async (req, res) => {
  try {
    const { zipPath, extractPath } = req.body;
    const serverPath = getServerPath(req.params.id);
    const fullZipPath = path.join(serverPath, zipPath);
    const fullExtractPath = path.join(serverPath, extractPath || '');

    // Check if zip file exists
    if (!(await fs.pathExists(fullZipPath))) {
      return res.status(404).json({ error: 'Zip file not found' });
    }

    // Create extraction directory if it doesn't exist
    await fs.ensureDir(fullExtractPath);

    // Extract the zip file
    const zip = new AdmZip(fullZipPath);
    zip.extractAllTo(fullExtractPath, true);

    res.json({ 
      message: 'File extracted successfully',
      extractPath: fullExtractPath
    });

  } catch (err) {
    console.error('Unzip error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/backups/:backupId/restore - Restore backup
app.post('/api/servers/:id/backups/:backupId/restore', async (req, res) => {
  try {
    const serverPath = getServerPath(req.params.id);
    const backupFile = path.join(serverPath, 'backups', req.params.backupId + '.zip');
    
    if (!await fs.pathExists(backupFile)) {
      return res.status(404).json({ error: 'Backup not found' });
    }
    
    // Stop server before restore
    const container = await getContainer(req.params.id);
    if (container) {
      const info = await container.inspect();
      if (info.State.Running) {
        await container.stop();
      }
    }
    
    // Extract backup
    const zip = new AdmZip(backupFile);
    zip.extractAllTo(serverPath, true);
    
    // Restart server
    if (container) {
      await container.start();
    }
    
    res.json({ message: 'Backup restored successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/servers/:id/config - Get server config
app.get('/api/servers/:id/config', async (req, res) => {
  try {
    const serverPath = getServerPath(req.params.id);
    const configPath = path.join(serverPath, 'server.properties');
    
    if (!await fs.pathExists(configPath)) {
      return res.json({});
    }
    
    const content = await fs.readFile(configPath, 'utf8');
    const config = {};
    
    content.split('\n').forEach(line => {
      if (line.trim() && !line.startsWith('#')) {
        const [key, value] = line.split('=');
        if (key && value !== undefined) {
          config[key.trim()] = value.trim();
        }
      }
    });
    
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/servers/:id/config - Update server config
app.put('/api/servers/:id/config', async (req, res) => {
  try {
    const serverPath = getServerPath(req.params.id);
    const configPath = path.join(serverPath, 'server.properties');
    
    const lines = Object.entries(req.body).map(([key, value]) => `${key}=${value}`);
    await fs.writeFile(configPath, lines.join('\n'));

    // Broadcast server details update (config changed)
    setTimeout(() => broadcastServerDetails(req.params.id), 500);

    res.json({ message: 'Configuration saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Utility functions
async function getDirectorySize(dirPath) {
  const files = await fs.readdir(dirPath);
  let size = 0;
  
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const stats = await fs.stat(filePath);
    
    if (stats.isDirectory()) {
      size += await getDirectorySize(filePath);
    } else {
      size += stats.size;
    }
  }
  
  return size;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function formatUptime(startedAt) {
  const start = new Date(startedAt);
  const diff = Date.now() - start.getTime();
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  return `${hours}h ${mins}m`;
}

async function isPortAvailable(port) {
  const net = require('net');
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, '0.0.0.0', () => {
      server.close(() => resolve(true));
    });
    server.on('error', () => {
      resolve(false);
    });
  });
}

async function findAvailablePort(startPort) {
  const net = require('net');

  // First, get all currently allocated ports from running containers
  const containers = await docker.listContainers({ all: false }); // Only running containers
  const allocatedPorts = new Set();

  containers.forEach(c => {
    c.Ports.forEach(p => {
      if (p.PublicPort) {
        allocatedPorts.add(p.PublicPort);
      }
    });
  });

  let port = startPort;
  while (true) {
    // Check if port is allocated by running containers
    if (allocatedPorts.has(port)) {
      port++;
      continue;
    }

    // Check if port can be bound by testing listen
    try {
      await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(port, '0.0.0.0', () => {
          server.close(() => resolve());
        });
        server.on('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            reject(new Error('Port in use'));
          } else {
            reject(err);
          }
        });
      });
      return port;
    } catch (err) {
      if (err.message === 'Port in use') {
        port++;
        continue;
      }
      throw err;
    }
  }
}

// Serve login configuration
app.get('/api/config/login', (req, res) => {
  res.json({
    password: process.env.LOGIN_PASSWORD || 'minecraft123',
    maxAttempts: process.env.MAX_LOGIN_ATTEMPTS || 5,
    lockoutMinutes: process.env.LOGIN_LOCKOUT_MINUTES || 5
  });
});

// Serve upload configuration
app.get('/api/config/upload', (req, res) => {
  res.json({
    maxFileSize: 500 * 1024 * 1024, // 500MB in bytes
    maxFileSizeMB: 500,
    maxFileSizeGB: 0.5,
    supportedTypes: ['.mcaddon', '.mcpack', '.mcworld', '.mctemplate'],
    chunkedUpload: false,
    resumableUpload: false
  });
});

// ==================== ADDON MANAGEMENT ====================

// Helper: Get addon directories
const getAddonPaths = (serverId) => {
  const serverPath = getServerPath(serverId);
  return {
    behaviorPacks: path.join(serverPath, 'behavior_packs'),
    resourcePacks: path.join(serverPath, 'resource_packs'),
    worlds: path.join(serverPath, 'worlds')
  };
};

// Helper: Extract manifest from addon
async function extractManifest(addonPath) {
  try {
    const zip = new AdmZip(addonPath);
    const entries = zip.getEntries();
    const manifestEntry = entries.find(e => e.entryName === 'manifest.json' || e.entryName.endsWith('/manifest.json'));

    if (manifestEntry) {
      const content = manifestEntry.getData().toString();
      return JSON.parse(content);
    }
    return null;
  } catch (err) {
    console.error('Error extracting manifest:', err);
    return null;
  }
}

// Helper: Get world name from server config
async function getWorldName(serverId) {
  try {
    const serverPath = getServerPath(serverId);
    const configPath = path.join(serverPath, 'server.properties');
    
    if (await fs.pathExists(configPath)) {
      const content = await fs.readFile(configPath, 'utf8');
      const levelNameMatch = content.match(/level-name=(.+)/);
      return levelNameMatch ? levelNameMatch[1].trim() : 'Bedrock level';
    }
    return 'Bedrock level';
  } catch (err) {
    return 'Bedrock level';
  }
}

// Helper: Parse JSON with error handling for malformed Minecraft manifests
async function parseManifestJson(manifestPath) {
  try {
    const content = await fs.readFile(manifestPath, 'utf8');
    // Clean common JSON issues in Minecraft manifests:
    // - Trailing commas before closing braces/brackets
    // - Single-line comments (//)
    // - Multi-line comments (/* */)
    const cleanedContent = content
      .replace(/,(\s*[}\]])/g, '$1') // Remove trailing commas
      .replace(/\/\/.*/g, '') // Remove single-line comments
      .replace(/\/\*[\s\S]*?\*\//g, ''); // Remove multi-line comments
    return JSON.parse(cleanedContent);
  } catch (err) {
    throw new Error(`Failed to parse manifest: ${err.message}`);
  }
}

// Helper: Generate safe folder name from addon filename
function generatePackFolderName(addonName, suffix) {
  // Remove extension from addon filename
  let baseName = addonName.replace(/\.[^/.]+$/, '');

  // Sanitize name: replace spaces and special chars with underscores
  baseName = baseName
    .replace(/[^a-zA-Z0-9\s\-_]/g, '') // Remove special chars except space, dash, underscore
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .replace(/_+/g, '_') // Replace multiple underscores with single
    .replace(/^_+|_+$/g, ''); // Trim underscores from start/end

  // Ensure baseName is not empty
  if (!baseName) {
    baseName = 'unknown_addon';
  }

  // Only add suffix if it's provided and not empty
  return suffix ? `${baseName}_${suffix}` : baseName;
}

// Helper: Generate unique folder name with conflict resolution
async function generateUniquePackFolderName(targetDir, manifest, suffix) {
  let baseName = generatePackFolderName(manifest, suffix);
  let finalName = baseName;
  let counter = 1;

  while (await fs.pathExists(path.join(targetDir, finalName))) {
    finalName = `${baseName}_${counter}`;
    counter++;
  }

  return finalName;
}

// GET /api/servers/:id/addons - List all addons
app.get('/api/servers/:id/addons', async (req, res) => {
  try {
    const paths = getAddonPaths(req.params.id);
    await fs.ensureDir(paths.behaviorPacks);
    await fs.ensureDir(paths.resourcePacks);

    const behaviorPacks = await fs.readdir(paths.behaviorPacks);
    const resourcePacks = await fs.readdir(paths.resourcePacks);

    const worldName = await getWorldName(req.params.id);
    const worldPath = path.join(paths.worlds, worldName);

    // Read enabled packs from world config
    let enabledBehaviorPacks = [];
    let enabledResourcePacks = [];

    const behaviorConfigPath = path.join(worldPath, 'world_behavior_packs.json');
    const resourceConfigPath = path.join(worldPath, 'world_resource_packs.json');

    if (await fs.pathExists(behaviorConfigPath)) {
      enabledBehaviorPacks = await fs.readJson(behaviorConfigPath);
    }

    if (await fs.pathExists(resourceConfigPath)) {
      enabledResourcePacks = await fs.readJson(resourceConfigPath);
    }

    // Create a map to combine addons by name
    const addonMap = new Map();

    // Process behavior packs
    await Promise.all(behaviorPacks.map(async pack => {
      const packPath = path.join(paths.behaviorPacks, pack);
      const stats = await fs.stat(packPath);

      let manifest = null;
      const manifestPath = path.join(packPath, 'manifest.json');
      if (await fs.pathExists(manifestPath)) {
        try {
          manifest = await parseManifestJson(manifestPath);
        } catch (err) {
          console.warn(`Failed to parse manifest for ${pack}:`, err.message);
          // Continue without manifest data
        }
      }

      const isEnabled = manifest && enabledBehaviorPacks.some(p => p.pack_id === manifest.header.uuid);

      if (!addonMap.has(pack)) {
        addonMap.set(pack, { name: pack, behaviorPack: null, resourcePack: null });
      }

      addonMap.get(pack).behaviorPack = {
        enabled: isEnabled,
        uuid: manifest?.header?.uuid || null,
        version: manifest?.header?.version || null,
        description: manifest?.header?.description || '',
        size: stats.isDirectory() ? await getDirectorySize(packPath) : stats.size,
        modified: stats.mtime,
        manifest: manifest
      };
    }));

    // Process resource packs
    await Promise.all(resourcePacks.map(async pack => {
      const packPath = path.join(paths.resourcePacks, pack);
      const stats = await fs.stat(packPath);

      let manifest = null;
      const manifestPath = path.join(packPath, 'manifest.json');
      if (await fs.pathExists(manifestPath)) {
        try {
          manifest = await parseManifestJson(manifestPath);
        } catch (err) {
          console.warn(`Failed to parse manifest for ${pack}:`, err.message);
          // Continue without manifest data
        }
      }

      const isEnabled = manifest && enabledResourcePacks.some(p => p.pack_id === manifest.header.uuid);

      if (!addonMap.has(pack)) {
        addonMap.set(pack, { name: pack, behaviorPack: null, resourcePack: null });
      }

      addonMap.get(pack).resourcePack = {
        enabled: isEnabled,
        uuid: manifest?.header?.uuid || null,
        version: manifest?.header?.version || null,
        description: manifest?.header?.description || '',
        size: stats.isDirectory() ? await getDirectorySize(packPath) : stats.size,
        modified: stats.mtime,
        manifest: manifest
      };
    }));

    // Create UUID map for dependency linking
    const uuidMap = new Map();
    addonMap.forEach((addon, name) => {
      if (addon.behaviorPack && addon.behaviorPack.uuid) {
        uuidMap.set(addon.behaviorPack.uuid, { type: 'behavior', name, addon });
      }
      if (addon.resourcePack && addon.resourcePack.uuid) {
        uuidMap.set(addon.resourcePack.uuid, { type: 'resource', name, addon });
      }
    });

    // Link addons by dependencies
    // Process behavior packs depending on resource packs
    addonMap.forEach((addon, name) => {
      if (addon.behaviorPack && addon.behaviorPack.manifest && addon.behaviorPack.manifest.dependencies) {
        for (const dep of addon.behaviorPack.manifest.dependencies) {
          if (uuidMap.has(dep.uuid)) {
            const depPack = uuidMap.get(dep.uuid);
            if (depPack.type === 'resource' && !addon.resourcePack) {
              addon.resourcePack = depPack.addon.resourcePack;
              // Remove the separate entry if names differ
              if (addonMap.has(depPack.name) && depPack.name !== name) {
                addonMap.delete(depPack.name);
              }
            }
          }
        }
      }
    });

    // Process resource packs depending on behavior packs
    addonMap.forEach((addon, name) => {
      if (addon.resourcePack && addon.resourcePack.manifest && addon.resourcePack.manifest.dependencies) {
        for (const dep of addon.resourcePack.manifest.dependencies) {
          if (uuidMap.has(dep.uuid)) {
            const depPack = uuidMap.get(dep.uuid);
            if (depPack.type === 'behavior' && !addon.behaviorPack) {
              addon.behaviorPack = depPack.addon.behaviorPack;
              // Remove the separate entry if names differ
              if (addonMap.has(depPack.name) && depPack.name !== name) {
                addonMap.delete(depPack.name);
              }
            }
          }
        }
      }
    });

    // Convert map to array
    const addons = Array.from(addonMap.values());

    res.json(addons);
  } catch (err) {
    console.error('Error listing addons:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/addons/upload - Upload addon files
const addonUpload = multer({
  dest: './temp/addon-uploads/',
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB limit for large addon files
    files: 1 // Only one file at a time
  }
});

// OPTIONS handler for upload endpoint
app.options('/api/servers/:id/addons/upload', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Content-Length');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('X-Max-Upload-Size', '500MB');
  res.setHeader('Accept-Ranges', 'bytes');
  res.status(200).end();
});

app.post('/api/servers/:id/addons/upload', addonUpload.single('addon'), async (req, res) => {
  res.setHeader('X-Max-Upload-Size', '500MB');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Upload-Progress', 'true');

  const serverId = req.params.id;
  const startTime = Date.now();

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileSize = req.file.size;
    const originalName = req.file.originalname;

    io.emit('upload-progress', {
      serverId,
      status: 'started',
      filename: originalName,
      size: fileSize,
      progress: 0
    });

    const paths = getAddonPaths(serverId);
    const ext = path.extname(originalName).toLowerCase();

    let targetDir;
    let addonType;

    if (ext === '.mcaddon') {
      addonType = 'mcaddon';
      targetDir = paths.behaviorPacks;
    } else if (ext === '.mcpack') {
      addonType = 'mcpack';
      targetDir = paths.resourcePacks;
    } else if (ext === '.mcworld') {
      addonType = 'mcworld';
      targetDir = paths.worlds;
    } else if (ext === '.mctemplate') {
      addonType = 'mctemplate';
      targetDir = paths.worlds;
    } else {
      await fs.remove(req.file.path);
      io.emit('upload-progress', {
        serverId,
        status: 'error',
        filename: originalName,
        error: 'Invalid file type. Only .mcaddon, .mcpack, .mcworld, and .mctemplate are supported'
      });
      return res.status(400).json({ error: 'Invalid file type. Only .mcaddon, .mcpack, .mcworld, and .mctemplate are supported' });
    }

    await fs.ensureDir(targetDir);

    io.emit('upload-progress', {
      serverId,
      status: 'processing',
      filename: originalName,
      progress: 25
    });

    if (ext === '.mcaddon') {
      const tempExtractPath = path.join('./temp', `extract-${Date.now()}`);
      await fs.ensureDir(tempExtractPath);

      const zip = new AdmZip(req.file.path);
      zip.extractAllTo(tempExtractPath, true);

      io.emit('upload-progress', {
        serverId,
        status: 'processing',
        filename: originalName,
        progress: 50
      });

      const extractedItems = await fs.readdir(tempExtractPath);
      let processedItems = 0;

      // Generate base name for this mcaddon file (without suffix)
      const baseName = path.basename(originalName, ext).replace(/[^a-zA-Z0-9\s\-_]/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
      const addonBaseName = baseName || 'unknown_addon';

      for (const item of extractedItems) {
        const itemPath = path.join(tempExtractPath, item);
        const stats = await fs.stat(itemPath);

        if (stats.isDirectory()) {
          if (item === 'behavior_packs' || item === 'behavior_pack') {
            const behaviorItems = await fs.readdir(itemPath);
            for (const pack of behaviorItems) {
              const sourcePath = path.join(itemPath, pack);
              const folderName = await generateUniquePackFolderName(paths.behaviorPacks, addonBaseName, '');
              const destPath = path.join(paths.behaviorPacks, folderName);
              await fs.copy(sourcePath, destPath, { overwrite: true });
              processedItems++;
            }
          } else if (item === 'resource_packs' || item === 'resource_pack') {
            const resourceItems = await fs.readdir(itemPath);
            for (const pack of resourceItems) {
              const sourcePath = path.join(itemPath, pack);
              const folderName = await generateUniquePackFolderName(paths.resourcePacks, addonBaseName, '');
              const destPath = path.join(paths.resourcePacks, folderName);
              await fs.copy(sourcePath, destPath, { overwrite: true });
              processedItems++;
            }
          } else {
            const manifestPath = path.join(itemPath, 'manifest.json');
            if (await fs.pathExists(manifestPath)) {
              try {
                const manifest = await parseManifestJson(manifestPath);
                const modules = manifest.modules || [];
                const isBehavior = modules.some(m => m.type === 'data' || m.type === 'javascript' || m.type === 'script');
                const targetPath = isBehavior ? paths.behaviorPacks : paths.resourcePacks;
                const folderName = await generateUniquePackFolderName(targetPath, addonBaseName, '');
                const destPath = path.join(targetPath, folderName);
                await fs.copy(itemPath, destPath, { overwrite: true });
                processedItems++;
              } catch (err) {
                const folderName = await generateUniquePackFolderName(paths.resourcePacks, addonBaseName, '');
                const destPath = path.join(paths.resourcePacks, folderName);
                await fs.copy(itemPath, destPath, { overwrite: true });
                processedItems++;
              }
            }
          }
        }
      }

      await fs.remove(tempExtractPath);
    } else if (ext === '.mcpack') {
      const baseName = path.basename(originalName, ext);
      const tempExtractPath = path.join('./temp', `extract-${Date.now()}`);
      await fs.ensureDir(tempExtractPath);

      const zip = new AdmZip(req.file.path);
      zip.extractAllTo(tempExtractPath, true);

      const extractedItems = await fs.readdir(tempExtractPath);
      const manifestPath = path.join(tempExtractPath, 'manifest.json');

      if (await fs.pathExists(manifestPath)) {
        // Direct content: create folder and move content into it
        const folderName = await generateUniquePackFolderName(targetDir, baseName, '');
        const newFolderPath = path.join(tempExtractPath, folderName);
        await fs.ensureDir(newFolderPath);

        // Move all items to new folder
        for (const item of extractedItems) {
          const src = path.join(tempExtractPath, item);
          const dest = path.join(newFolderPath, item);
          await fs.move(src, dest);
        }

        // Copy the new folder to targetDir
        await fs.copy(newFolderPath, path.join(targetDir, folderName), { overwrite: true });
      } else {
        // Assume folders: rename each folder
        for (const item of extractedItems) {
          const itemPath = path.join(tempExtractPath, item);
          const stats = await fs.stat(itemPath);
          if (stats.isDirectory()) {
            const folderName = await generateUniquePackFolderName(targetDir, baseName, '');
            const destPath = path.join(targetDir, folderName);
            await fs.copy(itemPath, destPath, { overwrite: true });
          }
        }
      }

      await fs.remove(tempExtractPath);
    } else if (ext === '.mcworld' || ext === '.mctemplate') {
      const worldName = path.basename(originalName, ext);
      const extractPath = path.join(targetDir, worldName);
      const zip = new AdmZip(req.file.path);
      zip.extractAllTo(extractPath, true);
    }

    io.emit('upload-progress', {
      serverId,
      status: 'processing',
      filename: originalName,
      progress: 75
    });

    await fs.remove(req.file.path);

    const duration = Date.now() - startTime;

    io.emit('upload-progress', {
      serverId,
      status: 'completed',
      filename: originalName,
      progress: 100,
      duration: duration
    });

    setTimeout(() => broadcastServerDetails(serverId), 500);

    res.json({
      message: 'Addon uploaded and extracted successfully',
      type: addonType,
      filename: originalName,
      duration: duration,
      size: fileSize
    });
  } catch (err) {
    const duration = Date.now() - startTime;
    const filename = req.file?.originalname || 'unknown';

    io.emit('upload-progress', {
      serverId,
      status: 'error',
      filename: filename,
      error: err.message,
      duration: duration
    });

    if (req.file) {
      await fs.remove(req.file.path).catch(() => {});
    }

    res.status(500).json({
      error: err.message,
      filename: filename,
      duration: duration
    });
  }
});

// POST /api/servers/:id/addons/:name/toggle - Enable/disable addon
app.post('/api/servers/:id/addons/:name/toggle', async (req, res) => {
  try {
    const { name } = req.params;
    const paths = getAddonPaths(req.params.id);

    // Get world path
    const worldName = await getWorldName(req.params.id);
    const worldPath = path.join(paths.worlds, worldName);
    await fs.ensureDir(worldPath);

    let toggledBehavior = false;
    let toggledResource = false;
    let behaviorEnabled = false;
    let resourceEnabled = false;

    // Handle behavior pack if it exists
    const behaviorPackPath = path.join(paths.behaviorPacks, name);
    if (await fs.pathExists(behaviorPackPath)) {
      const manifestPath = path.join(behaviorPackPath, 'manifest.json');
      if (await fs.pathExists(manifestPath)) {
        let manifest;
        try {
          manifest = await parseManifestJson(manifestPath);
        } catch (err) {
          console.warn(`Failed to parse manifest for behavior pack ${name}:`, err.message);
          // Continue without manifest data
        }

        if (manifest?.header?.uuid) {
          const uuid = manifest.header.uuid;
          const version = manifest.header.version;

          const configFile = path.join(worldPath, 'world_behavior_packs.json');
          let packs = [];
          if (await fs.pathExists(configFile)) {
            packs = await fs.readJson(configFile);
          }

          const packIndex = packs.findIndex(p => p.pack_id === uuid);

          if (packIndex >= 0) {
            // Disable - remove from list
            packs.splice(packIndex, 1);
            behaviorEnabled = false;
          } else {
            // Enable - add to list
            packs.push({
              pack_id: uuid,
              version: version
            });
            behaviorEnabled = true;
          }

          // Save config
          await fs.writeJson(configFile, packs, { spaces: 2 });
          toggledBehavior = true;
        }
      }
    }

    // Handle resource pack if it exists
    const resourcePackPath = path.join(paths.resourcePacks, name);
    if (await fs.pathExists(resourcePackPath)) {
      const manifestPath = path.join(resourcePackPath, 'manifest.json');
      if (await fs.pathExists(manifestPath)) {
        let manifest;
        try {
          manifest = await parseManifestJson(manifestPath);
        } catch (err) {
          console.warn(`Failed to parse manifest for resource pack ${name}:`, err.message);
          // Continue without manifest data
        }

        if (manifest?.header?.uuid) {
          const uuid = manifest.header.uuid;
          const version = manifest.header.version;

          const configFile = path.join(worldPath, 'world_resource_packs.json');
          let packs = [];
          if (await fs.pathExists(configFile)) {
            packs = await fs.readJson(configFile);
          }

          const packIndex = packs.findIndex(p => p.pack_id === uuid);

          if (packIndex >= 0) {
            // Disable - remove from list
            packs.splice(packIndex, 1);
            resourceEnabled = false;
          } else {
            // Enable - add to list
            packs.push({
              pack_id: uuid,
              version: version
            });
            resourceEnabled = true;
          }

          // Save config
          await fs.writeJson(configFile, packs, { spaces: 2 });
          toggledResource = true;
        }
      }
    }

    if (!toggledBehavior && !toggledResource) {
      return res.status(404).json({ error: 'Addon not found' });
    }

    // Broadcast server details update (addons changed)
    setTimeout(() => broadcastServerDetails(req.params.id), 500);

    let message = '';
    if (toggledBehavior && toggledResource) {
      message = behaviorEnabled || resourceEnabled ? 'Addon enabled' : 'Addon disabled';
    } else if (toggledBehavior) {
      message = behaviorEnabled ? 'Behavior pack enabled' : 'Behavior pack disabled';
    } else if (toggledResource) {
      message = resourceEnabled ? 'Resource pack enabled' : 'Resource pack disabled';
    }

    res.json({
      message: message,
      behaviorEnabled: behaviorEnabled,
      resourceEnabled: resourceEnabled
    });
  } catch (err) {
    console.error('Error toggling addon:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/servers/:id/addons/:name - Delete addon
app.delete('/api/servers/:id/addons/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const paths = getAddonPaths(req.params.id);

    let deletedBehavior = false;
    let deletedResource = false;
    let disabledBehavior = false;
    let disabledResource = false;

    // Get world path for config management
    const worldName = await getWorldName(req.params.id);
    const worldPath = path.join(paths.worlds, worldName);
    await fs.ensureDir(worldPath);

    // Handle behavior pack if it exists
    const behaviorPackPath = path.join(paths.behaviorPacks, name);
    if (await fs.pathExists(behaviorPackPath)) {
      // Read manifest to get UUID
      let uuid = null;
      const manifestPath = path.join(behaviorPackPath, 'manifest.json');
      if (await fs.pathExists(manifestPath)) {
        try {
          const manifest = await parseManifestJson(manifestPath);
          uuid = manifest?.header?.uuid || null;
        } catch (err) {
          console.warn(`Failed to parse manifest for behavior pack ${name}:`, err.message);
          // Continue with deletion even if manifest can't be parsed
        }
      }

      // Disable from world config if enabled and we have UUID
      if (uuid) {
        const configFile = path.join(worldPath, 'world_behavior_packs.json');
        if (await fs.pathExists(configFile)) {
          let packs = await fs.readJson(configFile);
          const packIndex = packs.findIndex(p => p.pack_id === uuid);
          if (packIndex >= 0) {
            // Remove the pack from config (disable it)
            packs.splice(packIndex, 1);
            await fs.writeJson(configFile, packs, { spaces: 2 });
            disabledBehavior = true;
          }
        }
      }

      // Remove from filesystem
      await fs.remove(behaviorPackPath);
      deletedBehavior = true;
    }

    // Handle resource pack if it exists
    const resourcePackPath = path.join(paths.resourcePacks, name);
    if (await fs.pathExists(resourcePackPath)) {
      // Read manifest to get UUID
      let uuid = null;
      const manifestPath = path.join(resourcePackPath, 'manifest.json');
      if (await fs.pathExists(manifestPath)) {
        try {
          const manifest = await parseManifestJson(manifestPath);
          uuid = manifest?.header?.uuid || null;
        } catch (err) {
          console.warn(`Failed to parse manifest for resource pack ${name}:`, err.message);
          // Continue with deletion even if manifest can't be parsed
        }
      }

      // Disable from world config if enabled and we have UUID
      if (uuid) {
        const configFile = path.join(worldPath, 'world_resource_packs.json');
        if (await fs.pathExists(configFile)) {
          let packs = await fs.readJson(configFile);
          const packIndex = packs.findIndex(p => p.pack_id === uuid);
          if (packIndex >= 0) {
            // Remove the pack from config (disable it)
            packs.splice(packIndex, 1);
            await fs.writeJson(configFile, packs, { spaces: 2 });
            disabledResource = true;
          }
        }
      }

      // Remove from filesystem
      await fs.remove(resourcePackPath);
      deletedResource = true;
    }

    if (!deletedBehavior && !deletedResource) {
      return res.status(404).json({ error: 'Addon not found' });
    }

    let message = 'Addon deleted successfully';
    if (deletedBehavior && deletedResource) {
      message = 'Behavior pack and resource pack deleted successfully';
      if (disabledBehavior || disabledResource) {
        message += ' (previously active packs were disabled first)';
      }
    } else if (deletedBehavior) {
      message = 'Behavior pack deleted successfully';
      if (disabledBehavior) {
        message += ' (was disabled first)';
      }
    } else if (deletedResource) {
      message = 'Resource pack deleted successfully';
      if (disabledResource) {
        message += ' (was disabled first)';
      }
    }

    res.json({ message: message });
  } catch (err) {
    console.error('Error deleting addon:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/servers/:id/worlds - List available worlds
app.get('/api/servers/:id/worlds', async (req, res) => {
  try {
    const paths = getAddonPaths(req.params.id);
    await fs.ensureDir(paths.worlds);

    const worlds = await fs.readdir(paths.worlds);
    const worldList = await Promise.all(worlds.map(async world => {
      const worldPath = path.join(paths.worlds, world);
      const stats = await fs.stat(worldPath);

      if (!stats.isDirectory()) return null;

      const size = await getDirectorySize(worldPath);

      // Check for level.dat to confirm it's a valid world
      const levelDatPath = path.join(worldPath, 'level.dat');
      const isValid = await fs.pathExists(levelDatPath);

      return {
        name: world,
        size: formatBytes(size),
        modified: stats.mtime,
        isValid
      };
    }));

    res.json(worldList.filter(w => w !== null));
  } catch (err) {
    console.error('Error listing worlds:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/worlds/:worldName/enable - Enable world by setting level-name
app.post('/api/servers/:id/worlds/:worldName/enable', async (req, res) => {
  try {
    const { id, worldName } = req.params;
    const serverPath = getServerPath(id);
    const configPath = path.join(serverPath, 'server.properties');

    // Check if world exists
    const paths = getAddonPaths(id);
    const worldPath = path.join(paths.worlds, worldName);
    if (!await fs.pathExists(worldPath)) {
      return res.status(404).json({ error: 'World not found' });
    }

    // Read current config
    let configContent = '';
    if (await fs.pathExists(configPath)) {
      configContent = await fs.readFile(configPath, 'utf8');
    } else {
      return res.status(404).json({ error: 'Server configuration not found' });
    }

    // Update level-name
    const lines = configContent.split('\n');
    let levelNameUpdated = false;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('level-name=')) {
        lines[i] = `level-name=${worldName}`;
        levelNameUpdated = true;
        break;
      }
    }

    // If level-name wasn't found, add it
    if (!levelNameUpdated) {
      lines.push(`level-name=${worldName}`);
    }

    // Write updated config
    await fs.writeFile(configPath, lines.join('\n'));

    // Restart server to apply changes
    const container = await getContainer(id);
    if (container) {
      const info = await container.inspect();
      if (info.State.Running) {
        await container.restart();
        // Broadcast server update after restart
        setTimeout(() => broadcastServerUpdate(id), 5000);
      }
    }

    res.json({
      message: `World "${worldName}" enabled successfully. Server restarted to apply changes.`
    });
  } catch (err) {
    console.error('Error enabling world:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/servers/:id/worlds/:worldName - Delete world
app.delete('/api/servers/:id/worlds/:worldName', async (req, res) => {
  try {
    const { id, worldName } = req.params;
    const serverPath = getServerPath(id);
    const configPath = path.join(serverPath, 'server.properties');

    // Check if world exists
    const paths = getAddonPaths(id);
    const worldPath = path.join(paths.worlds, worldName);
    if (!await fs.pathExists(worldPath)) {
      return res.status(404).json({ error: 'World not found' });
    }

    // Check if this is the currently active world
    if (await fs.pathExists(configPath)) {
      const configContent = await fs.readFile(configPath, 'utf8');
      const levelNameMatch = configContent.match(/level-name=(.+)/);
      const currentWorld = levelNameMatch ? levelNameMatch[1].trim() : 'Bedrock level';

      if (currentWorld === worldName) {
        return res.status(400).json({ error: 'Cannot delete the currently active world. Please enable another world first.' });
      }
    }

    // Delete the world directory
    await fs.remove(worldPath);

    res.json({
      message: `World "${worldName}" deleted successfully`
    });
  } catch (err) {
    console.error('Error deleting world:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== END ADDON MANAGEMENT ====================

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send initial data to new client
  socket.on('request-initial-data', async () => {
    try {
      const containers = await docker.listContainers({ all: true });
      const bedrockServers = containers.filter(c =>
        c.Image.includes(BEDROCK_IMAGE) && c.Labels['server-id']
      );

      const servers = await Promise.all(bedrockServers.map(async c => {
        const container = docker.getContainer(c.Id);
        const info = await container.inspect();
        const serverId = c.Labels['server-id'];
        const serverPath = getServerPath(serverId);

        let serverName = c.Labels['server-name'] || serverId;
        let serverVersion = 'LATEST';
        try {
          const metadataPath = path.join(serverPath, 'metadata.json');
          if (await fs.pathExists(metadataPath)) {
            const metadata = await fs.readJson(metadataPath);
            if (metadata.name) serverName = metadata.name;
            if (metadata.version) serverVersion = metadata.version;
          }
        } catch (err) {}

        let worldSize = '0 MB';
        try {
          const worldPath = path.join(serverPath, 'worlds');
          if (await fs.pathExists(worldPath)) {
            const size = await getDirectorySize(worldPath);
            worldSize = formatBytes(size);
          }
        } catch (err) {}

        return {
          id: serverId,
          name: serverName,
          version: serverVersion,
          status: c.State,
          players: 0, // Will be updated separately
          maxPlayers: 10,
          uptime: info.State.Running ? formatUptime(info.State.StartedAt) : '0h 0m',
          memory: formatBytes(info.HostConfig.Memory || 0),
          cpu: '0%',
          worldSize: worldSize,
          ports: c.Ports,
          webPort: PORT
        };
      }));

      socket.emit('servers-update', servers);
    } catch (err) {
      console.error('Error sending initial data:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Helper function to broadcast server updates
async function broadcastServerUpdate(serverId = null) {
  try {
    const containers = await docker.listContainers({ all: true });
    const bedrockServers = containers.filter(c =>
      c.Image.includes(BEDROCK_IMAGE) && c.Labels['server-id']
    );

    const servers = await Promise.all(bedrockServers.map(async c => {
      const container = docker.getContainer(c.Id);
      const info = await container.inspect();
      const currentServerId = c.Labels['server-id'];
      const serverPath = getServerPath(currentServerId);

      let serverName = c.Labels['server-name'] || currentServerId;
      let serverVersion = 'LATEST';
      let containerName = currentServerId;
      try {
        const metadataPath = path.join(serverPath, 'metadata.json');
        if (await fs.pathExists(metadataPath)) {
          const metadata = await fs.readJson(metadataPath);
          if (metadata.name) serverName = metadata.name;
          if (metadata.version) serverVersion = metadata.version;
          if (metadata.containerName) containerName = metadata.containerName;
        }
      } catch (err) {}

      let worldSize = '0 MB';
      try {
        const worldPath = path.join(serverPath, 'worlds');
        if (await fs.pathExists(worldPath)) {
          const size = await getDirectorySize(worldPath);
          worldSize = formatBytes(size);
        }
      } catch (err) {}

      let playerCount = 0;
      if (c.State === 'running') {
        try {
          const exec = await container.exec({
            Cmd: ['send-command', 'list'],
            AttachStdout: true,
            AttachStderr: true
          });
          await exec.start();
          await new Promise(resolve => setTimeout(resolve, 500));
          const logs = await container.logs({
            stdout: true,
            stderr: true,
            tail: 20
          });
          const logText = logs.toString();
          const lines = logText.trim().split('\n');
          let lastIndex = -1;
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('players online:')) {
              lastIndex = i;
            }
          }
          if (lastIndex >= 0) {
            for (let i = lastIndex + 1; i < lines.length; i++) {
              const line = lines[i].trim();
              if (line.startsWith('[') || line.startsWith('>') || line.includes('AutoCompaction') || line === '') {
                break;
              }
              if (line) playerCount++;
            }
          }
        } catch (err) {}
      }

      let maxPlayers = 10;
      try {
        const configPath = path.join(serverPath, 'server.properties');
        if (await fs.pathExists(configPath)) {
          const content = await fs.readFile(configPath, 'utf8');
          const maxPlayersMatch = content.match(/max-players=(\d+)/);
          if (maxPlayersMatch) {
            maxPlayers = parseInt(maxPlayersMatch[1]);
          }
        }
      } catch (err) {}

      return {
        id: currentServerId,
        name: serverName,
        containerName: (c.Names && c.Names[0]) ? c.Names[0].replace('/', '') : containerName,
        version: serverVersion,
        status: c.State,
        players: playerCount,
        maxPlayers: maxPlayers,
        uptime: info.State.Running ? formatUptime(info.State.StartedAt) : '0h 0m',
        memory: formatBytes(info.HostConfig.Memory || 0),
        cpu: '0%',
        worldSize: worldSize,
        ports: c.Ports,
        webPort: PORT
      };
    }));

    io.emit('servers-update', servers);

    // If specific server updated, also emit detailed data
    if (serverId) {
      await broadcastServerDetails(serverId);
    }
  } catch (err) {
    console.error('Error broadcasting server update:', err);
  }
}

// Helper function to broadcast server details with timeout
async function broadcastServerDetails(serverId) {
  try {
    await Promise.race([
      (async () => {
        const container = await getContainer(serverId);
        if (!container) return;

        const logs = await container.logs({
          stdout: true,
          stderr: true,
          tail: 50
        });
        const logLines = logs.toString().split('\n').filter(l => l.trim());

        let players = [];
        const containerInfo = await container.inspect();
        if (containerInfo.State.Status === 'running') {
          let logs;
          try {
            const exec = await container.exec({
              Cmd: ['send-command', 'list'],
              AttachStdout: true,
              AttachStderr: true
            });
            await exec.start();
            await new Promise(resolve => setTimeout(resolve, 300));
            logs = await container.logs({
              stdout: true,
              stderr: true,
              tail: 15
            });
          } catch (err) {
            return;
          }

          const logText = logs.toString();
          const lines = logText.trim().split('\n');
          const players_temp = [];

          let lastIndex = -1;
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('players online:')) {
              lastIndex = i;
            }
          }

          if (lastIndex >= 0) {
            for (let i = lastIndex + 1; i < lines.length; i++) {
              const line = lines[i].trim();
              if (line.startsWith('[') || line.startsWith('>') || line.includes('AutoCompaction') || line === '') {
                break;
              }
              if (line) {
                const names = line.split(',').map(n => n.replace(/[^\x20-\x7E]/g, '').trim()).filter(n => n);
                players_temp.push(...names.map(name => ({ name })));
              }
            }
          }

          let playerCache = {};
          const cachePath = path.join(getServerPath(serverId), 'player_cache.json');
          try {
            if (await fs.pathExists(cachePath)) {
              const cacheContent = await fs.readFile(cachePath, 'utf8');
              playerCache = JSON.parse(cacheContent);
            }
          } catch (err) {}

          const uncachedPlayers = players_temp.filter(p => !playerCache[p.name]).slice(0, 3);

          if (uncachedPlayers.length > 0) {
            for (const player of uncachedPlayers) {
              try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 2000);

                const response = await fetch(`https://mcprofile.io/api/v1/bedrock/gamertag/${encodeURIComponent(player.name)}`, {
                  signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (response.ok) {
                  const data = await response.json();
                  player.xuid = data.xuid || null;
                  playerCache[player.name] = player.xuid;
                } else {
                  player.xuid = null;
                }
              } catch (err) {
                player.xuid = null;
              }
              await new Promise(resolve => setTimeout(resolve, 50));
            }

            try {
              await fs.writeJson(cachePath, playerCache, { spaces: 2 });
            } catch (err) {}
          }

          players_temp.forEach(player => {
            if (playerCache[player.name]) {
              player.xuid = playerCache[player.name];
            }
          });

          let permissions = [];
          try {
            const permissionsPath = path.join(getServerPath(serverId), 'permissions.json');
            if (await fs.pathExists(permissionsPath)) {
              const permissionsContent = await fs.readFile(permissionsPath, 'utf8');
              permissions = JSON.parse(permissionsContent);
            }
          } catch (err) {}

          const operatorXuids = permissions.filter(p => p.permission === 'operator').map(p => p.xuid);
          players_temp.forEach(player => {
            player.isOperator = player.xuid && operatorXuids.includes(player.xuid);
          });

          players = players_temp;
        }

        let config = {};
        try {
          const serverPath = getServerPath(serverId);
          const configPath = path.join(serverPath, 'server.properties');
          if (await fs.pathExists(configPath)) {
            const content = await fs.readFile(configPath, 'utf8');
            content.split('\n').forEach(line => {
              if (line.trim() && !line.startsWith('#')) {
                const [key, value] = line.split('=');
                if (key && value !== undefined) {
                  config[key.trim()] = value.trim();
                }
              }
            });
          }
        } catch (err) {}

        io.emit('server-details-update', {
          serverId,
          logs: logLines,
          players,
          config
        });
      })(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Broadcast timeout after 10 seconds')), 10000);
      })
    ]);
  } catch (err) {
    if (!err.message.includes('Broadcast timeout')) {
      console.error('Error broadcasting server details:', err);
    }
  }
}

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, async () => {
  await ensureTempDirs();
  console.log(`Bedrock Server Manager API running on port ${PORT}`);
  console.log('Login configuration:');
  console.log(`- Password: ${process.env.LOGIN_PASSWORD ? '[SET]' : '[DEFAULT]'}`);
  console.log(`- Max login attempts: ${process.env.MAX_LOGIN_ATTEMPTS || 5}`);
  console.log(`- Lockout duration: ${process.env.LOGIN_LOCKOUT_MINUTES || 5} minutes`);
  console.log(`- Session timeout: 24 hours (hardcoded)`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Temp directory: ./temp/`);
  console.log(`WebSocket server ready for real-time updates`);
});