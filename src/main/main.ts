// main.ts
import { app, BrowserWindow, ipcMain } from 'electron';
import {
  Client, McpServersConfig,
  ListToolsResultSchema, CallToolResultSchema,
  ListPromptsResultSchema, GetPromptResultSchema,
  ListResourcesResultSchema, ReadResourceResultSchema, ListResourceTemplatesResultSchema
} from './types.js';
import { initializeClient, manageRequests } from './client.js';

import notifier from 'node-notifier';

import path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

let appPath;

if (app.isPackaged) {
  // Electron Packaged
  appPath = path.dirname(process.execPath);
} else {
  // Dev
  appPath = app.getAppPath();
}

console.log('Current Path:', appPath);

const configPath = path.join(appPath, 'config.json');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const preloadPath = path.resolve(__dirname, '..', 'preload', 'preload.js');
const indexPath = path.resolve(__dirname, '..', 'renderer', 'index.html');

interface ClientObj {
  name: string;
  client: Client;
  capabilities: Record<string, any> | undefined;
}

function readConfig(configPath: string): McpServersConfig | null {
  try {
    const config = readFileSync(configPath, 'utf8');
    return JSON.parse(config);
  } catch (error) {
    console.error('Error reading config file:', error);
    return null;
  }
}

async function initClient(): Promise<ClientObj[]> {
  const config = readConfig(configPath);
  if (config) {
    console.log('Config loaded:', config);

    try {
      const clients = await Promise.all(
        Object.entries(config.mcpServers).map(async ([name, serverConfig]) => {
          console.log(`Initializing client for ${name} with config:`, serverConfig);

          const timeoutPromise = new Promise<Client>((resolve, reject) => {
            setTimeout(() => {
              reject(new Error(`Initialization of client for ${name} timed out after 30 seconds`));
            }, 30000); // 30 seconds
          });

          const client = await Promise.race([
            initializeClient(name, serverConfig),
            timeoutPromise,
          ]);

          console.log(`${name} initialized.`);
          const capabilities = client.getServerCapabilities();
          return { name, client, capabilities };
        })
      );

      console.log('All clients initialized.');
      notifier.notify({
        appID: 'AIQL',
        title: "MCP Servers are ready",
        message: "All Clients initialized."
      });

      return clients;
    } catch (error) {
      console.error('Error during client initialization:', error?.message);
      notifier.notify({
        appID: 'AIQL',
        title: 'Client initialization failed',
        message: "Cannot start with current config, " +  error?.message,
      });

      process.exit(1);
    }
  } else {
    console.log('NO clients initialized.');
    notifier.notify({
      appID: 'AIQL',
      title: 'NO clients initialized',
      message: "NO valid JSON config found.",
    });
    return [];
  }
}

async function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath
    }
  });

  mainWindow.loadFile(indexPath);

  // You can uncomment the following line to enable DevTools permanently.
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(async () => {

  const clients = await initClient();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  ipcMain.handle('list-clients', () => {
    return features;
  });

  function registerIpcHandlers(
    name: string,
    client: Client,
    capabilities: Record<string, any> | undefined) {

    const feature: { [key: string]: any } = { name };

    const registerHandler = (method: string, schema: any) => {
      const eventName = `${name}-${method}`;
      console.log(`IPC Main ${eventName}`);
      ipcMain.handle(eventName, async (event, params) => {
        return await manageRequests(client, `${method}`, schema, params);
      });
      return eventName;
    };

    const capabilitySchemas = {
      tools: {
        list: ListToolsResultSchema,
        call: CallToolResultSchema,
      },
      prompts: {
        list: ListPromptsResultSchema,
        get: GetPromptResultSchema,
      },
      resources: {
        list: ListResourcesResultSchema,
        read: ReadResourceResultSchema,
        'templates/list': ListResourceTemplatesResultSchema,
      },
    };

    for (const [type, actions] of Object.entries(capabilitySchemas)) {
      if (capabilities?.[type]) {
        feature[type] = {};
        for (const [action, schema] of Object.entries(actions)) {
          feature[type][action] = registerHandler(`${type}/${action}`, schema);
        }
      }
    }

    return feature;
  }

  const features = clients.map(({ name, client, capabilities }) => {
    console.log('Capabilities:', name, '\n', capabilities);
    return registerIpcHandlers(name, client, capabilities);
  });

  console.log(features)

});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

