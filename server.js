// server.js - Minecraft Bedrock Server Manager Backend
// npm install express cors dockerode archiver fs-extra unzipper dotenv multer
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Docker = require('dockerode');
const fs = require('fs-extra');
const path = require('path');
const archiver = require('archiver');
const unzipper = require('unzipper');
const fsPromises = require('fs').promises;
const multer = require('multer');

const app = express();
// Cross-platform Docker configuration
const dockerConfig = process.platform === 'win32'
  ? { host: 'localhost', port: 2375 } // Windows Docker Desktop (ensure TCP is enabled)
  : { socketPath: '/var/run/docker.sock' }; // Linux/Unix socket
const docker = new Docker(dockerConfig);

app.use(cors());
app.use(express.json());

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Configuration
const DATA_DIR = process.env.DATA_DIR;
const BEDROCK_IMAGE = 'itzg/minecraft-bedrock-server';

// Helper: Get server data path
const getServerPath = (serverId) => path.join(DATA_DIR, serverId);

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

      // Get server name from metadata or fallback to label
      let serverName = c.Labels['server-name'] || serverId;
      try {
        const metadataPath = path.join(serverPath, 'metadata.json');
        if (await fs.pathExists(metadataPath)) {
          const metadata = await fs.readJson(metadataPath);
          if (metadata.name) {
            serverName = metadata.name;
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

      return {
        id: serverId,
        name: serverName,
        status: c.State,
        players: 0, // Would need to parse logs or use RCON
        maxPlayers: 10,
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

// POST /api/servers - Create new server
app.post('/api/servers', async (req, res) => {
  try {
    const { name } = req.body;
    const serverId = `bedrock-${Date.now()}`;
    const serverPath = getServerPath(serverId);

    // Create server directory
    await fs.ensureDir(serverPath);

    // Create metadata file
    const metadataPath = path.join(serverPath, 'metadata.json');
    const metadata = {
      name: name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await fs.writeJson(metadataPath, metadata, { spaces: 2 });

    // Find available ports
    const gamePort = await findAvailablePort(19132);
    const rconPort = await findAvailablePort(25575);

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
        'GAMEMODE=survival',
        'DIFFICULTY=normal',
        'SERVER_NAME=' + name
      ],
      HostConfig: {
        Binds: [`${serverPath}:/data`],
        PortBindings: {
          '19132/udp': [{ HostPort: gamePort.toString() }],
          '19133/tcp': [{ HostPort: rconPort.toString() }]
        },
        RestartPolicy: {
          Name: 'unless-stopped'
        },
        Memory: 2 * 1024 * 1024 * 1024 // 2GB
      }
    });

    await container.start();

    res.json({
      id: serverId,
      name,
      gamePort,
      rconPort,
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
    
    await container.start();
    res.json({ message: 'Server started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/stop - Stop server
app.post('/api/servers/:id/stop', async (req, res) => {
  try {
    const container = await getContainer(req.params.id);
    if (!container) return res.status(404).json({ error: 'Server not found' });
    
    await container.stop();
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

    res.json({
      message: 'Server renamed successfully',
      name: name.trim()
    });
  } catch (err) {
    console.error('Error renaming server:', err);
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
    
    res.json({ 
      response: output || 'Command sent successfully. Check server logs for output.',
      message: 'Command executed via send-command script'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/servers/:id/players - Get player list from logs
app.get('/api/servers/:id/players', async (req, res) => {
  try {
    const container = await getContainer(req.params.id);
    if (!container) return res.status(404).json({ error: 'Server not found' });
    
    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail: 500
    });
    
    const logText = logs.toString();
    const players = new Set();
    
    // Parse player connections from logs
    const playerRegex = /Player connected: (.+?),/g;
    let match;
    while ((match = playerRegex.exec(logText)) !== null) {
      players.add(match[1]);
    }
    
    // Parse player disconnections to remove them
    const disconnectRegex = /Player disconnected: (.+?),/g;
    while ((match = disconnectRegex.exec(logText)) !== null) {
      players.delete(match[1]);
    }
    
    res.json(Array.from(players).map(name => ({ name })));
  } catch (err) {
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
const upload = multer({ dest: '/tmp/uploads/' });

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
    await new Promise((resolve, reject) => {
      fs.createReadStream(fullZipPath)
        .pipe(unzipper.Extract({ path: fullExtractPath }))
        .on('close', resolve)
        .on('error', reject);
    });

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
    const unzipper = require('unzipper');
    await fs.createReadStream(backupFile)
      .pipe(unzipper.Extract({ path: serverPath }))
      .promise();
    
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

async function findAvailablePort(startPort) {
  const containers = await docker.listContainers({ all: true });
  const usedPorts = new Set();
  
  containers.forEach(c => {
    c.Ports.forEach(p => {
      if (p.PublicPort) usedPorts.add(p.PublicPort);
    });
  });
  
  let port = startPort;
  while (usedPorts.has(port)) {
    port++;
  }
  return port;
}

// Serve login configuration
app.get('/api/config/login', (req, res) => {
  res.json({
    maxAttempts: process.env.MAX_LOGIN_ATTEMPTS || 5,
    lockoutMinutes: process.env.LOGIN_LOCKOUT_MINUTES || 5
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
    const directory = await unzipper.Open.file(addonPath);
    const manifestFile = directory.files.find(f => f.path === 'manifest.json' || f.path.endsWith('/manifest.json'));
    
    if (manifestFile) {
      const content = await manifestFile.buffer();
      return JSON.parse(content.toString());
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
    
    // Process behavior packs
    const behaviorPacksList = await Promise.all(behaviorPacks.map(async pack => {
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
      
      return {
        name: pack,
        type: 'behavior',
        enabled: isEnabled,
        uuid: manifest?.header?.uuid || null,
        version: manifest?.header?.version || null,
        description: manifest?.header?.description || '',
        size: stats.isDirectory() ? await getDirectorySize(packPath) : stats.size,
        modified: stats.mtime
      };
    }));
    
    // Process resource packs
    const resourcePacksList = await Promise.all(resourcePacks.map(async pack => {
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
      
      return {
        name: pack,
        type: 'resource',
        enabled: isEnabled,
        uuid: manifest?.header?.uuid || null,
        version: manifest?.header?.version || null,
        description: manifest?.header?.description || '',
        size: stats.isDirectory() ? await getDirectorySize(packPath) : stats.size,
        modified: stats.mtime
      };
    }));
    
    res.json({
      behaviorPacks: behaviorPacksList,
      resourcePacks: resourcePacksList
    });
  } catch (err) {
    console.error('Error listing addons:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/addons/upload - Upload addon files
const addonUpload = multer({ dest: '/tmp/addon-uploads/' });

app.post('/api/servers/:id/addons/upload', addonUpload.single('addon'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const paths = getAddonPaths(req.params.id);
    const originalName = req.file.originalname;
    const ext = path.extname(originalName).toLowerCase();
    
    // Determine addon type and target directory
    let targetDir;
    let addonType;
    
    if (ext === '.mcaddon') {
      // mcaddon can contain both behavior and resource packs
      addonType = 'mcaddon';
      targetDir = paths.behaviorPacks; // Will extract to both
    } else if (ext === '.mcpack') {
      // mcpack is typically a resource pack
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
      return res.status(400).json({ error: 'Invalid file type. Only .mcaddon, .mcpack, .mcworld, and .mctemplate are supported' });
    }
    
    await fs.ensureDir(targetDir);
    
    // Extract the addon
    if (ext === '.mcaddon') {
      // Extract mcaddon - it may contain behavior_packs and/or resource_packs folders
      const tempExtractPath = path.join('/tmp', `extract-${Date.now()}`);
      await fs.ensureDir(tempExtractPath);
      
      await fs.createReadStream(req.file.path)
        .pipe(unzipper.Extract({ path: tempExtractPath }))
        .promise();
      
      // Check for behavior_packs and resource_packs folders
      const extractedItems = await fs.readdir(tempExtractPath);
      
      for (const item of extractedItems) {
        const itemPath = path.join(tempExtractPath, item);
        const stats = await fs.stat(itemPath);
        
        if (stats.isDirectory()) {
          if (item === 'behavior_packs' || item === 'behavior_pack') {
            // Copy behavior packs
            const behaviorItems = await fs.readdir(itemPath);
            for (const pack of behaviorItems) {
              await fs.copy(path.join(itemPath, pack), path.join(paths.behaviorPacks, pack), { overwrite: true });
            }
          } else if (item === 'resource_packs' || item === 'resource_pack') {
            // Copy resource packs
            const resourceItems = await fs.readdir(itemPath);
            for (const pack of resourceItems) {
              await fs.copy(path.join(itemPath, pack), path.join(paths.resourcePacks, pack), { overwrite: true });
            }
          } else {
            // Single pack directory - try to determine type from manifest
            const manifestPath = path.join(itemPath, 'manifest.json');
            if (await fs.pathExists(manifestPath)) {
              try {
                const manifest = await parseManifestJson(manifestPath);
                const modules = manifest.modules || [];
                const isBehavior = modules.some(m => m.type === 'data' || m.type === 'javascript');
                
                if (isBehavior) {
                  await fs.copy(itemPath, path.join(paths.behaviorPacks, item), { overwrite: true });
                } else {
                  await fs.copy(itemPath, path.join(paths.resourcePacks, item), { overwrite: true });
                }
              } catch (err) {
                console.warn(`Failed to parse manifest for ${item}, defaulting to resource pack:`, err.message);
                // Default to resource pack if manifest can't be parsed
                await fs.copy(itemPath, path.join(paths.resourcePacks, item), { overwrite: true });
              }
            }
          }
        }
      }
      
      await fs.remove(tempExtractPath);
    } else if (ext === '.mcpack') {
      // Extract mcpack to resource_packs
      const packName = path.basename(originalName, ext);
      const extractPath = path.join(targetDir, packName);
      
      await fs.createReadStream(req.file.path)
        .pipe(unzipper.Extract({ path: extractPath }))
        .promise();
    } else if (ext === '.mcworld' || ext === '.mctemplate') {
      // Extract world/template
      const worldName = path.basename(originalName, ext);
      const extractPath = path.join(targetDir, worldName);
      
      await fs.createReadStream(req.file.path)
        .pipe(unzipper.Extract({ path: extractPath }))
        .promise();
    }
    
    // Clean up uploaded file
    await fs.remove(req.file.path);
    
    res.json({ 
      message: 'Addon uploaded and extracted successfully',
      type: addonType,
      filename: originalName
    });
  } catch (err) {
    console.error('Error uploading addon:', err);
    if (req.file) {
      await fs.remove(req.file.path).catch(() => {});
    }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/addons/:type/:name/toggle - Enable/disable addon
app.post('/api/servers/:id/addons/:type/:name/toggle', async (req, res) => {
  try {
    const { type, name } = req.params;
    const paths = getAddonPaths(req.params.id);
    
    const packPath = type === 'behavior' 
      ? path.join(paths.behaviorPacks, name)
      : path.join(paths.resourcePacks, name);
    
    // Read manifest
    const manifestPath = path.join(packPath, 'manifest.json');
    if (!await fs.pathExists(manifestPath)) {
      return res.status(404).json({ error: 'Manifest not found' });
    }
    
    let manifest;
    try {
      manifest = await parseManifestJson(manifestPath);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid manifest.json: ' + err.message });
    }
    
    const uuid = manifest.header.uuid;
    const version = manifest.header.version;
    
    // Get world path
    const worldName = await getWorldName(req.params.id);
    const worldPath = path.join(paths.worlds, worldName);
    await fs.ensureDir(worldPath);
    
    // Determine config file
    const configFile = type === 'behavior' 
      ? path.join(worldPath, 'world_behavior_packs.json')
      : path.join(worldPath, 'world_resource_packs.json');
    
    // Read current config
    let packs = [];
    if (await fs.pathExists(configFile)) {
      packs = await fs.readJson(configFile);
    }
    
    // Toggle pack
    const packIndex = packs.findIndex(p => p.pack_id === uuid);
    
    if (packIndex >= 0) {
      // Disable - remove from list
      packs.splice(packIndex, 1);
    } else {
      // Enable - add to list
      packs.push({
        pack_id: uuid,
        version: version
      });
    }
    
    // Save config
    await fs.writeJson(configFile, packs, { spaces: 2 });
    
    res.json({ 
      message: packIndex >= 0 ? 'Addon disabled' : 'Addon enabled',
      enabled: packIndex < 0
    });
  } catch (err) {
    console.error('Error toggling addon:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/servers/:id/addons/:type/:name - Delete addon
app.delete('/api/servers/:id/addons/:type/:name', async (req, res) => {
  try {
    const { type, name } = req.params;
    const paths = getAddonPaths(req.params.id);
    
    const packPath = type === 'behavior' 
      ? path.join(paths.behaviorPacks, name)
      : path.join(paths.resourcePacks, name);
    
    if (!await fs.pathExists(packPath)) {
      return res.status(404).json({ error: 'Addon not found' });
    }
    
    // Remove from filesystem
    await fs.remove(packPath);
    
    // Remove from world config if enabled
    const worldName = await getWorldName(req.params.id);
    const worldPath = path.join(paths.worlds, worldName);
    const configFile = type === 'behavior' 
      ? path.join(worldPath, 'world_behavior_packs.json')
      : path.join(worldPath, 'world_resource_packs.json');
    
    if (await fs.pathExists(configFile)) {
      let packs = await fs.readJson(configFile);
      // We can't filter by UUID since we deleted the manifest, so we'll keep the config as-is
      // The server will ignore missing packs
    }
    
    res.json({ message: 'Addon deleted successfully' });
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

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Bedrock Server Manager API running on port ${PORT}`);
  console.log('Login configuration:');
  console.log(`- Max login attempts: ${process.env.MAX_LOGIN_ATTEMPTS || 5}`);
  console.log(`- Lockout duration: ${process.env.LOGIN_LOCKOUT_MINUTES || 5} minutes`);
  console.log(`Data directory: ${DATA_DIR}`);
});