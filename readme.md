
## Minecraft Bedrock Server Manager

Full-stack application to manage multiple Minecraft Bedrock servers using itzg/docker-minecraft-bedrock-server.

## How it works

The aplication will deploy a minecraft bedrock server using docker itzg/docker-minecraft-bedrock-server latest image, assign port, persistent volume. The aplication then act as UI to manage this container.

### Features
- ✅ Real-time WebSocket Updates
- ✅ Multiple server management
- ✅ Select server version (Latest, Latest Preview or custom)
- ✅ Start/Stop/Restart containers
- ✅ Server renaming
- ✅ Console command
- ✅ Allocate container memory/ram
- ✅ Advanced File Manager
  - Upload multiple files
  - Download files
  - Delete files/folders
  - Rename files/folders
  - Edit files inline (text editor)
  - Create new folders
  - Navigate folder structure
  - Context menu (right-click)
  - Zip/Unzip files and folders
  - Keyboard shortcuts
- ✅ Addon Management
  - Upload .mcaddon, .mcpack, .mcworld, .mctemplate files
  - Enable/disable behavior packs
  - Enable/disable resource packs
  - Automatic manifest parsing
  - World configuration management
  - View installed worlds
  - Switch between worlds
  - Delete worlds
- ✅ Backup & restore worlds
- ✅ Server configuration editor
- ✅ Player management (kick, ban, op, deop)
- ✅ Dynamic port allocation
- ✅ Web-based UI
- ✅ Password-protected login
- ✅ Session-based authentication
- ✅ Mobile responsive design


### WebSocket Real-time Features
This application uses WebSocket for real-time updates, providing instant UI synchronization across multiple browser tabs without manual refresh.

- **Automatic Fallback**: If WebSocket connection fails, the app automatically falls back to HTTP polling (30-second intervals)
- **Cross-tab Sync**: Changes made in one browser tab instantly appear in all other open tabs

- **Network Requirements**: WebSocket uses the same port as the HTTP server (default: 3001)
- **Firewall**: Ensure port 3001 is open for both HTTP and WebSocket connections

---

### Linux Installation

#### Prerequisites
- Docker installed
- Node.js 18+

Download the source  code

#### 1. **Install Dependencies**
```bash
# Install backend dependencies (includes WebSocket support)
npm install

```

#### 2. **Configure Environment**
Create a `.env` file in the root directory:
```bash
# Server Configuration
PORT=3001
DATA_DIR=/opt/minecraft-servers #change this to your data directory

# Authentication
LOGIN_PASSWORD=your_secure_password_here
MAX_LOGIN_ATTEMPTS=5
LOGIN_LOCKOUT_MINUTES=5
```

#### 3. **Create Data Directory**
```bash
# Create directory for server data
sudo mkdir -p /opt/minecraft-servers #change this to your data directory
sudo chown $USER:$USER /opt/minecraft-servers #change this to your data directory
```

#### 4. **WebSocket Setup**
```bash
# Run WebSocket setup 
npm run setup
```

#### 5. **Start the Application**
```bash
# Start the app (run on PM2)
npm start
```
**Access the application at: `http://localhost:3001`**

---

### Docker Deployment

#### Prerequisites
- Docker installed
- Docker Compose installed

#### Docker Desktop Configuration
1. Open Docker Desktop
2. Go to Settings → General
3. Enable "Expose daemon on tcp://localhost:2375 without TLS"
4. Restart Docker Desktop


Image : https://hub.docker.com/r/mugh/bdsmanagerforitzg

#### Docker Compose Example
---
```bash
services:
  server-manager:
    image: mugh/bdsmanagerforitzg:latest
    ports:
      - "3001:3001"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - minecraft-data:/app/minecraft-data
    environment:
      - PORT=3001
      - LOGIN_PASSWORD=minecraft123
      - MAX_LOGIN_ATTEMPTS=5
      - LOGIN_LOCKOUT_MINUTES=5
      #- DOCKER_HOST=tcp://host.docker.internal:2375 #for system with restricted direct mounting to /var/run/docker.sock (windows or NAS)
    networks:
      - minecraft-network

volumes:
  minecraft-data:

networks:
  minecraft-network:
    driver: bridge
```

#### Access the application
   The application will be available at `http://localhost:3001`
   Default login password: `minecraft123` (change in environtment variables)

#### Environment Variables
You can customize the deployment by editing the `docker-compose.yml` file:
- `LOGIN_PASSWORD`: Set your desired password
- `PORT`: Change the port if needed (default: 3001)
- `MAX_LOGIN_ATTEMPTS`: Maximum failed login attempt
- `LOGIN_LOCKOUT_MINUTES`: duration of lockout in case or reaching MAX_LOGIN_ATTEMPTS

#### Volumes
- `minecraft-data`: Persistent storage for Minecraft server data
- `/var/run/docker.sock`: Allows the app to manage Docker containers

---

## [SUPPORT ME](https://sociabuzz.com/mughniy/donate)



## Screenshot
![enter image description here](https://github.com/mugh/minecraftbedrockservermanager/blob/main/Screenshot/sc1.png?raw=true)
![enter image description here](https://github.com/mugh/minecraftbedrockservermanager/blob/main/Screenshot/sc2.png?raw=true)
![enter image description here](https://github.com/mugh/minecraftbedrockservermanager/blob/main/Screenshot/sc3.png?raw=true)
![enter image description here](https://github.com/mugh/minecraftbedrockservermanager/blob/main/Screenshot/sc4.png?raw=true)








