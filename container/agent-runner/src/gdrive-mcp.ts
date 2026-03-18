/**
 * Google Drive MCP Server for NanoClaw
 * Provides full Drive access (read, write, share/manage)
 * Credentials loaded from /home/node/.gdrive-mcp/credentials.json
 */

import fs from 'fs';
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { google } from 'googleapis';

const CREDENTIALS_PATH = path.join('/home/node/.gdrive-mcp', 'credentials.json');
const OAUTH_KEYS_PATH = path.join('/home/node/.gdrive-mcp', 'gcp-oauth.keys.json');

function loadAuth() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error('Google Drive credentials not found. Run gdrive auth first.');
  }
  if (!fs.existsSync(OAUTH_KEYS_PATH)) {
    throw new Error('Google Drive OAuth keys not found at ' + OAUTH_KEYS_PATH);
  }
  const keys = JSON.parse(fs.readFileSync(OAUTH_KEYS_PATH, 'utf-8'));
  const { client_id, client_secret, redirect_uris } = keys.installed || keys.web;
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  const tokens = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
  oauth2.setCredentials(tokens);
  // Auto-refresh and persist updated tokens
  oauth2.on('tokens', (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(merged, null, 2));
  });
  return oauth2;
}

const server = new Server(
  { name: 'gdrive', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'gdrive_list_files',
      description: 'List files and folders in Google Drive. Optionally filter by folder or query.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: "Drive search query (e.g. name contains 'report' or mimeType='application/vnd.google-apps.folder')" },
          folder_id: { type: 'string', description: 'Folder ID to list contents of (default: root)' },
          page_size: { type: 'number', description: 'Max results (default 20)' },
        },
      },
    },
    {
      name: 'gdrive_read_file',
      description: 'Read the text content of a Google Drive file by its file ID.',
      inputSchema: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: 'The Drive file ID' },
        },
        required: ['file_id'],
      },
    },
    {
      name: 'gdrive_create_file',
      description: 'Create a new file in Google Drive.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'File name' },
          content: { type: 'string', description: 'Text content of the file' },
          mime_type: { type: 'string', description: 'MIME type (default: text/plain)' },
          folder_id: { type: 'string', description: 'Parent folder ID (default: root)' },
        },
        required: ['name', 'content'],
      },
    },
    {
      name: 'gdrive_update_file',
      description: 'Update the content or name of an existing Drive file.',
      inputSchema: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: 'The Drive file ID' },
          content: { type: 'string', description: 'New text content' },
          name: { type: 'string', description: 'New file name (optional)' },
        },
        required: ['file_id'],
      },
    },
    {
      name: 'gdrive_delete_file',
      description: 'Delete a file or folder from Google Drive.',
      inputSchema: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: 'The Drive file ID to delete' },
        },
        required: ['file_id'],
      },
    },
    {
      name: 'gdrive_share_file',
      description: 'Share a Drive file with a user or make it public.',
      inputSchema: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: 'The Drive file ID' },
          email: { type: 'string', description: 'Email to share with (omit for public)' },
          role: { type: 'string', description: 'Permission role: reader, commenter, writer, owner (default: reader)' },
          public: { type: 'boolean', description: 'Make file publicly accessible (anyone with link)' },
        },
        required: ['file_id'],
      },
    },
    {
      name: 'gdrive_create_folder',
      description: 'Create a new folder in Google Drive.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Folder name' },
          parent_id: { type: 'string', description: 'Parent folder ID (default: root)' },
        },
        required: ['name'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const auth = loadAuth();
  const drive = google.drive({ version: 'v3', auth });
  const { name, arguments: args } = request.params;

  try {
    if (name === 'gdrive_list_files') {
      const q = [
        args?.query as string || '',
        args?.folder_id ? `'${args.folder_id}' in parents` : '',
        'trashed = false',
      ].filter(Boolean).join(' and ');

      const res = await drive.files.list({
        q: q || 'trashed = false',
        pageSize: (args?.page_size as number) || 20,
        fields: 'files(id,name,mimeType,size,modifiedTime,parents)',
      });

      const files = res.data.files || [];
      const text = files.length === 0
        ? 'No files found.'
        : files.map(f => `${f.name} (${f.id}) [${f.mimeType}]${f.size ? ` ${Math.round(Number(f.size) / 1024)}KB` : ''}`).join('\n');

      return { content: [{ type: 'text', text }] };
    }

    if (name === 'gdrive_read_file') {
      const fileId = args?.file_id as string;
      const meta = await drive.files.get({ fileId, fields: 'mimeType,name' });
      const mimeType = meta.data.mimeType || '';

      let text: string;
      if (mimeType.startsWith('application/vnd.google-apps')) {
        // Export Google Docs/Sheets/Slides as plain text
        const exportMime = mimeType.includes('spreadsheet') ? 'text/csv'
          : mimeType.includes('presentation') ? 'text/plain'
          : 'text/plain';
        const res = await drive.files.export({ fileId, mimeType: exportMime }, { responseType: 'text' });
        text = res.data as string;
      } else {
        const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' });
        text = res.data as string;
      }

      return { content: [{ type: 'text', text: `# ${meta.data.name}\n\n${text}` }] };
    }

    if (name === 'gdrive_create_file') {
      const res = await drive.files.create({
        requestBody: {
          name: args?.name as string,
          parents: args?.folder_id ? [args.folder_id as string] : undefined,
        },
        media: {
          mimeType: (args?.mime_type as string) || 'text/plain',
          body: args?.content as string,
        },
        fields: 'id,name',
      });
      return { content: [{ type: 'text', text: `Created: ${res.data.name} (ID: ${res.data.id})` }] };
    }

    if (name === 'gdrive_update_file') {
      const fileId = args?.file_id as string;
      const res = await drive.files.update({
        fileId,
        requestBody: args?.name ? { name: args.name as string } : undefined,
        media: args?.content ? { mimeType: 'text/plain', body: args.content as string } : undefined,
        fields: 'id,name',
      });
      return { content: [{ type: 'text', text: `Updated: ${res.data.name} (ID: ${res.data.id})` }] };
    }

    if (name === 'gdrive_delete_file') {
      await drive.files.delete({ fileId: args?.file_id as string });
      return { content: [{ type: 'text', text: `Deleted file ${args?.file_id}` }] };
    }

    if (name === 'gdrive_share_file') {
      const fileId = args?.file_id as string;
      if (args?.public) {
        await drive.permissions.create({
          fileId,
          requestBody: { role: 'reader', type: 'anyone' },
        });
        const meta = await drive.files.get({ fileId, fields: 'webViewLink' });
        return { content: [{ type: 'text', text: `Made public. Link: ${meta.data.webViewLink}` }] };
      } else {
        await drive.permissions.create({
          fileId,
          requestBody: {
            role: (args?.role as string) || 'reader',
            type: 'user',
            emailAddress: args?.email as string,
          },
          sendNotificationEmail: true,
        });
        return { content: [{ type: 'text', text: `Shared with ${args?.email} as ${args?.role || 'reader'}` }] };
      }
    }

    if (name === 'gdrive_create_folder') {
      const res = await drive.files.create({
        requestBody: {
          name: args?.name as string,
          mimeType: 'application/vnd.google-apps.folder',
          parents: args?.parent_id ? [args.parent_id as string] : undefined,
        },
        fields: 'id,name',
      });
      return { content: [{ type: 'text', text: `Created folder: ${res.data.name} (ID: ${res.data.id})` }] };
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
