
## Minecraft Bedrock Server Manager

Full-stack application to manage multiple Minecraft Bedrock servers using itzg/docker-minecraft-bedrock-server.

## How it works

The aplication will create a minecraft bedrock server using docker itzg/docker-minecraft-bedrock-server, assign port, persistent volume. The aplication then act as UI to manage this container.

### Features
- ✅ Multiple server management
- ✅ Start/Stop/Restart containers
- ✅ Server renaming
- ✅ Real-time logs & monitoring
- ✅ Console commands
- ✅ **Advanced File Manager**
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
- ✅ **Addon Management** 🆕
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
- ✅ Web-based UI (no build required!)
- ✅ Password-protected login
- ✅ Session-based authentication
- ✅ Mobile responsive design

### Prerequisites
- Docker installed
- Node.js 18+

---

### Installation
Download the source  code

#### 1. **Install Dependencies**
```bash
# Install backend dependencies
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

#### 4. **Start the Application**
```bash
# Start the app (run on PM2)
npm start
```
**Access the application at: `http://localhost:3001`**

---

### File Manager Usage

The built-in file manager supports comprehensive file operations:

**Upload Files**
1. Navigate to Files tab
2. Click "📤 Upload" button
3. Select one or multiple files
4. Files will be uploaded to current directory

**Edit Files**
1. Double-click any text file
2. Edit content in the modal editor
3. Click "💾 Save" to save changes
4. Supports .properties, .json, .txt, .yml, etc.

**Rename Files/Folders**
1. Click ✏️ icon on any file/folder
2. Enter new name
3. Click Rename

**Navigate Folders**
- Double-click folder to open
- Click "⬆️ Up" to go to parent directory
- Current path shown at top

**Create New Folder**
1. Click "📁 New Folder"
2. Enter folder name
3. Folder created in current directory

**Delete Files/Folders**
- Click 🗑️ icon
- Confirm deletion
- Works for both files and folders

**Context Menu** (Right-click)
- Right-click any file for quick actions:
  - ⬇️ Download
  - 📦 Zip (create archive)
  - 📤 Unzip (extract archive)
  - ✏️ Rename
  - 📝 Edit (files only)
  - 🗑️ Delete

**Keyboard Shortcuts**
- Double-click file: Open editor
- Double-click folder: Navigate into folder
- Right-click: Show context menu

### Addon Management 🆕

Manage Minecraft Bedrock addons directly through the web interface!

**Quick Start:**
1. Go to the **Addons** tab
2. Click **"+ Upload Addon"**
3. Select your `.mcaddon`, `.mcpack`, `.mcworld`, or `.mctemplate` file
4. Enable the addon (for behavior/resource packs)
5. Restart the server

**Supported Formats:**
- **`.mcaddon`** - Behavior/Resource pack bundles
- **`.mcpack`** - Resource packs (textures, sounds)
- **`.mcworld`** - Complete world saves
- **`.mctemplate`** - World templates

**Features:**
- Automatic extraction and installation
- Enable/disable packs without deleting
- View pack details (version, description, size)
- Automatic `world_behavior_packs.json` and `world_resource_packs.json` management
- Support for multiple packs simultaneously

**World Management:**
- Switch between different worlds
- Enable/Disable worlds
- Delete worlds (except currently active world)
- View world details (size, modification date, validity)

### Player Management

Manage players directly from the web interface:
- **View Online Players** - See who's currently connected
- **Kick Players** - Temporarily remove players with optional reason
- **Ban Players** - Permanently ban players with optional reason
- **OP/Deop** - Grant or revoke operator permissions

### Server Management

- **Server Renaming** - Rename servers without recreating them
- **Dynamic Port Allocation** - Automatic port assignment to avoid conflicts
- **Real-time Monitoring** - Live server stats and logs
- **Container Management** - Full Docker container lifecycle management

### Security

The application includes password protection:
- Set `LOGIN_PASSWORD` in `.env` file
- Configure max login attempts and lockout duration
- Session-based authentication
- Mobile responsive design for all devices
- Real-time updates without page refresh

## [SUPPORT ME](https://sociabuzz.com/mughniy/donate)










