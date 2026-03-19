import type { SkillMetadata, SkillContext, SkillResult, SkillResultAttachment } from '@alfred/types';
import fs from 'node:fs';
import path from 'node:path';
import { Skill } from '../skill.js';

const MAX_READ_SIZE = 500_000; // 500KB
const MAX_SEND_SIZE = 50_000_000; // 50MB

const MIME_MAP: Record<string, string> = {
  // Documents
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.rtf': 'application/rtf',
  '.epub': 'application/epub+zip',
  // Text
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.ini': 'text/plain',
  '.cfg': 'text/plain',
  '.log': 'text/plain',
  // Code
  '.json': 'application/json',
  '.js': 'application/javascript',
  '.ts': 'application/typescript',
  '.py': 'text/x-python',
  '.sh': 'application/x-sh',
  '.sql': 'application/sql',
  '.css': 'text/css',
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  // Video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  // Archives
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  // Fonts
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export class FileSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'file',
    category: 'files',
    description:
      'Read, write, move, copy, or send files. Use for reading file contents, writing text to files, ' +
      'saving binary data, listing directory contents, moving/copying files, or getting file info. ' +
      'Use "send" to deliver a file to the user in the chat (PDF, images, etc.) — works with both local paths and FileStore keys. ' +
      'Use "read_store" / "list_store" / "delete_store" to access files in the FileStore (S3/NFS) — e.g. inbox attachments the user sent. ' +
      'When a message contains [Saved to FileStore ... key="<key>"], use "read_store" or "send" with that key. ' +
      'IMPORTANT: For large content (HTML pages, long text), use code_sandbox instead to generate the file programmatically.',
    riskLevel: 'write',
    version: '2.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'write', 'write_binary', 'append', 'list', 'info', 'exists', 'move', 'copy', 'delete', 'send', 'read_store', 'write_store', 'list_store', 'delete_store'],
          description: 'The file operation to perform',
        },
        path: {
          type: 'string',
          description: 'Absolute or relative file/directory path (~ expands to home)',
        },
        destination: {
          type: 'string',
          description: 'Destination path for move/copy actions (~ expands to home)',
        },
        content: {
          type: 'string',
          description: 'Content to write (required for write/append; base64-encoded for write_binary)',
        },
      },
      required: ['action', 'path'],
    },
  };

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as string;
    const rawPath = input.path as string;
    const content = input.content as string | undefined;
    const destination = input.destination as string | undefined;

    if (!action || !rawPath) {
      return { success: false, error: 'Missing required fields "action" and "path"' };
    }

    // Validate content early for actions that require it, so the LLM gets
    // a clear error message and can retry with content instead of burning iterations.
    if ((action === 'write' || action === 'write_binary' || action === 'append') && !content) {
      return { success: false, error: `Missing "content" field for "${action}" action. The content is likely too large to include in a tool call. Use the code_sandbox skill instead — write COMPACT data-driven code: define your data as arrays/objects, then build HTML/text programmatically with .map()/.join(). Example: const data = [{h:8,p:5.2},{h:9,p:4.1}]; const rows = data.map(r => \`<tr><td>\${r.h}</td><td>\${r.p}</td></tr>\`).join(''); fs.writeFileSync('output.html', \`<table>\${rows}</table>\`); — the sandbox collects output files automatically. Do NOT embed large string literals.` };
    }

    const resolvedPath = this.resolvePath(rawPath);

    // Block access to sensitive system directories and files
    const blockedResult = this.checkBlocked(resolvedPath);
    if (blockedResult) {
      return blockedResult;
    }

    // Reject symlinks that resolve to blocked paths
    try {
      if (fs.existsSync(resolvedPath) && fs.lstatSync(resolvedPath).isSymbolicLink()) {
        const realTarget = fs.realpathSync(resolvedPath);
        const targetBlocked = this.checkBlocked(realTarget);
        if (targetBlocked) {
          return { success: false, error: 'Access denied: symlink target is a blocked path' };
        }
      }
    } catch {
      // If we can't check the symlink, continue — the operation itself will fail if needed
    }

    switch (action) {
      case 'read': return this.readFile(resolvedPath);
      case 'write': return this.writeFile(resolvedPath, content);
      case 'write_binary': return this.writeBinaryFile(resolvedPath, content);
      case 'append': return this.appendFile(resolvedPath, content);
      case 'list': return this.listDir(resolvedPath);
      case 'info': return this.fileInfo(resolvedPath);
      case 'exists': return this.fileExists(resolvedPath);
      case 'move': return this.moveFile(resolvedPath, destination);
      case 'copy': return this.copyFile(resolvedPath, destination);
      case 'delete': return this.deleteFile(resolvedPath);
      case 'send': return this.sendFile(rawPath, _context);
      case 'read_store': return this.readFromStore(rawPath, _context);
      case 'write_store': return this.writeToStore(rawPath, content, _context);
      case 'list_store': return this.listFromStore(_context);
      case 'delete_store': return this.deleteFromStore(rawPath, _context);
      default:
        return { success: false, error: `Unknown action "${action}". Valid: read, write, write_binary, append, list, info, exists, move, copy, delete, send, read_store, list_store, delete_store` };
    }
  }

  private resolvePath(raw: string): string {
    const home = process.env['HOME'] || process.env['USERPROFILE'] || '';
    const expanded = raw.startsWith('~') ? raw.replace('~', home) : raw;
    return path.resolve(expanded);
  }

  private checkBlocked(filePath: string): SkillResult | null {
    const lowerPath = filePath.toLowerCase().replace(/\\/g, '/');
    const home = (process.env['HOME'] || process.env['USERPROFILE'] || '').toLowerCase().replace(/\\/g, '/');
    const blocked = [
      '/etc/shadow', '/etc/passwd', '/etc/sudoers',
      '/proc/', '/sys/', '/dev/',
      'c:/windows/system32', 'c:/windows/syswow64',
    ];
    const blockedHome = ['/.ssh', '/.aws', '/.gnupg'];
    const blockedFiles = ['.env'];

    if (blocked.some(b => lowerPath.startsWith(b) || lowerPath === b.replace(/\/$/, ''))) {
      return { success: false, error: 'Access to system directories/files is blocked for security' };
    }
    if (home && blockedHome.some(b => lowerPath.startsWith(home + b))) {
      return { success: false, error: 'Access to sensitive user directories is blocked for security' };
    }
    const baseName = path.basename(filePath);
    if (blockedFiles.includes(baseName.toLowerCase())) {
      return { success: false, error: 'Access to sensitive files is blocked for security' };
    }
    return null;
  }

  private readFile(filePath: string): SkillResult {
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        return { success: false, error: `"${filePath}" is a directory, not a file. Use action "list" instead.` };
      }
      if (stat.size > MAX_READ_SIZE) {
        const content = fs.readFileSync(filePath, 'utf-8').slice(0, MAX_READ_SIZE);
        return {
          success: true,
          data: { path: filePath, size: stat.size, truncated: true },
          display: `${filePath} (${stat.size} bytes, truncated to ${MAX_READ_SIZE}):\n\n${content}`,
        };
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      return {
        success: true,
        data: { path: filePath, size: stat.size, content },
        display: content,
      };
    } catch (err) {
      return { success: false, error: `Cannot read "${filePath}": ${(err as Error).message}` };
    }
  }

  private writeFile(filePath: string, content: string | undefined): SkillResult {
    if (content === undefined || content === null) {
      return { success: false, error: 'Missing "content" for write action' };
    }
    try {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');
      return {
        success: true,
        data: { path: filePath, bytes: Buffer.byteLength(content) },
        display: `Written ${Buffer.byteLength(content)} bytes to ${filePath}`,
      };
    } catch (err) {
      return { success: false, error: `Cannot write "${filePath}": ${(err as Error).message}` };
    }
  }

  private appendFile(filePath: string, content: string | undefined): SkillResult {
    if (content === undefined || content === null) {
      return { success: false, error: 'Missing "content" for append action' };
    }
    try {
      fs.appendFileSync(filePath, content, 'utf-8');
      return {
        success: true,
        data: { path: filePath, appendedBytes: Buffer.byteLength(content) },
        display: `Appended ${Buffer.byteLength(content)} bytes to ${filePath}`,
      };
    } catch (err) {
      return { success: false, error: `Cannot append to "${filePath}": ${(err as Error).message}` };
    }
  }

  private listDir(dirPath: string): SkillResult {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const items = entries.map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'symlink' : 'file',
      }));

      const display = items.length === 0
        ? `${dirPath}: (empty)`
        : items.map(i => `${i.type === 'dir' ? '📁' : '📄'} ${i.name}`).join('\n');

      return { success: true, data: { path: dirPath, entries: items }, display };
    } catch (err) {
      return { success: false, error: `Cannot list "${dirPath}": ${(err as Error).message}` };
    }
  }

  private fileInfo(filePath: string): SkillResult {
    try {
      const stat = fs.statSync(filePath);
      const info = {
        path: filePath,
        type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
        size: stat.size,
        created: stat.birthtime.toISOString(),
        modified: stat.mtime.toISOString(),
        permissions: stat.mode.toString(8),
      };
      return {
        success: true,
        data: info,
        display: `${info.type}: ${filePath}\nSize: ${stat.size} bytes\nModified: ${info.modified}`,
      };
    } catch (err) {
      return { success: false, error: `Cannot stat "${filePath}": ${(err as Error).message}` };
    }
  }

  private fileExists(filePath: string): SkillResult {
    const exists = fs.existsSync(filePath);
    return {
      success: true,
      data: { path: filePath, exists },
      display: exists ? `Yes, "${filePath}" exists` : `No, "${filePath}" does not exist`,
    };
  }

  private writeBinaryFile(filePath: string, base64Content: string | undefined): SkillResult {
    if (!base64Content) {
      return { success: false, error: 'Missing "content" (base64-encoded) for write_binary action' };
    }
    try {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      const buffer = Buffer.from(base64Content, 'base64');
      fs.writeFileSync(filePath, buffer);
      return {
        success: true,
        data: { path: filePath, bytes: buffer.length },
        display: `Written ${buffer.length} bytes (binary) to ${filePath}`,
      };
    } catch (err) {
      return { success: false, error: `Cannot write "${filePath}": ${(err as Error).message}` };
    }
  }

  private moveFile(source: string, destination: string | undefined): SkillResult {
    if (!destination) {
      return { success: false, error: 'Missing "destination" for move action' };
    }
    const resolvedDest = this.resolvePath(destination);
    const destBlocked = this.checkBlocked(resolvedDest);
    if (destBlocked) {
      return destBlocked;
    }
    try {
      const destDir = path.dirname(resolvedDest);
      fs.mkdirSync(destDir, { recursive: true });
      fs.renameSync(source, resolvedDest);
      return {
        success: true,
        data: { from: source, to: resolvedDest },
        display: `Moved ${source} → ${resolvedDest}`,
      };
    } catch (err) {
      // rename fails across filesystems — fall back to copy + delete
      try {
        fs.copyFileSync(source, resolvedDest);
        fs.unlinkSync(source);
        return {
          success: true,
          data: { from: source, to: resolvedDest },
          display: `Moved ${source} → ${resolvedDest}`,
        };
      } catch (err2) {
        return { success: false, error: `Cannot move "${source}" to "${resolvedDest}": ${(err2 as Error).message}` };
      }
    }
  }

  private copyFile(source: string, destination: string | undefined): SkillResult {
    if (!destination) {
      return { success: false, error: 'Missing "destination" for copy action' };
    }
    const resolvedDest = this.resolvePath(destination);
    const destBlocked = this.checkBlocked(resolvedDest);
    if (destBlocked) {
      return destBlocked;
    }
    try {
      const destDir = path.dirname(resolvedDest);
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(source, resolvedDest);
      return {
        success: true,
        data: { from: source, to: resolvedDest },
        display: `Copied ${source} → ${resolvedDest}`,
      };
    } catch (err) {
      return { success: false, error: `Cannot copy "${source}" to "${resolvedDest}": ${(err as Error).message}` };
    }
  }

  private async sendFile(rawPath: string, context: SkillContext): Promise<SkillResult> {
    // Detect FileStore keys: not absolute, not ~, contains /
    const isStoreKey = !path.isAbsolute(rawPath) && !rawPath.startsWith('~') && rawPath.includes('/') && context.fileStore;

    if (isStoreKey && context.fileStore) {
      try {
        const data = await context.fileStore.read(rawPath, context.userId);
        if (data.length === 0) return { success: false, error: `Store key "${rawPath}" is empty (0 bytes)` };
        if (data.length > MAX_SEND_SIZE) return { success: false, error: `File too large to send (${data.length} bytes, max ${MAX_SEND_SIZE})` };
        const rawName = rawPath.split('/').pop() ?? rawPath;
        // Strip timestamp prefix: "2026-03-18T22-06-31-071Z_CV.pdf" → "CV.pdf"
        const fileName = rawName.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z?_/, '');
        const ext = path.extname(fileName).toLowerCase();
        const mimeType = MIME_MAP[ext] || 'application/octet-stream';
        return {
          success: true,
          data: { key: rawPath, size: data.length, fileName, mimeType },
          display: `Sending ${fileName} (${data.length} bytes) from FileStore`,
          attachments: [{ fileName, data, mimeType }],
        };
      } catch (err) {
        return { success: false, error: `Cannot read from FileStore key "${rawPath}": ${(err as Error).message}` };
      }
    }

    // Local file path
    const filePath = this.resolvePath(rawPath);
    try {
      if (!fs.existsSync(filePath)) {
        return { success: false, error: `"${filePath}" does not exist` };
      }
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        return { success: false, error: `"${filePath}" is a directory, not a file` };
      }
      if (stat.size === 0) {
        return { success: false, error: `"${filePath}" is empty (0 bytes) — cannot send an empty file` };
      }
      if (stat.size > MAX_SEND_SIZE) {
        return { success: false, error: `File too large to send (${stat.size} bytes, max ${MAX_SEND_SIZE})` };
      }
      const data = fs.readFileSync(filePath);
      const fileName = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mimeType = MIME_MAP[ext] || 'application/octet-stream';
      const attachment: SkillResultAttachment = { fileName, data, mimeType };
      return {
        success: true,
        data: { path: filePath, size: stat.size, fileName, mimeType },
        display: `Sending ${fileName} (${stat.size} bytes)`,
        attachments: [attachment],
      };
    } catch (err) {
      return { success: false, error: `Cannot send "${filePath}": ${(err as Error).message}` };
    }
  }

  private async readFromStore(key: string, context: SkillContext): Promise<SkillResult> {
    const store = context.fileStore;
    if (!store) {
      return this.readFile(this.resolvePath(key));
    }
    try {
      const data = await store.read(key, context.userId);
      const isText = data.length < MAX_READ_SIZE && !data.includes(0);
      if (isText) {
        const text = data.toString('utf-8');
        return {
          success: true,
          data: { key, size: data.length },
          display: text,
        };
      }
      return {
        success: true,
        data: { key, size: data.length, binary: true },
        display: `Binary file (${data.length} bytes). Use "send" to deliver to user, or "document search" for indexed content.`,
      };
    } catch (err) {
      return { success: false, error: `Cannot read store key "${key}": ${(err as Error).message}` };
    }
  }

  private async writeToStore(fileName: string, content: string | undefined, context: SkillContext): Promise<SkillResult> {
    const store = context.fileStore;
    if (!store) {
      // Fallback: write locally
      if (!content) return { success: false, error: 'Missing "content" for write_store action' };
      return this.writeFile(this.resolvePath(fileName), content);
    }
    if (!content) return { success: false, error: 'Missing "content" for write_store action' };
    try {
      // Detect base64 binary content: must have padding AND no whitespace/punctuation
      const isBase64 = /^[A-Za-z0-9+/\s]+=+$/.test(content.trim()) && content.length > 100 && !content.includes(' ');
      const data = isBase64 ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf-8');
      const stored = await store.save(context.userId, fileName, data);
      return {
        success: true,
        data: { key: stored.key, fileName: stored.fileName, size: stored.size },
        display: `Saved to FileStore: ${stored.key} (${stored.size} bytes)`,
      };
    } catch (err) {
      return { success: false, error: `Cannot write to store "${fileName}": ${(err as Error).message}` };
    }
  }

  private async listFromStore(context: SkillContext): Promise<SkillResult> {
    const store = context.fileStore;
    if (!store) {
      return { success: false, error: 'No FileStore configured. Use action "list" with a directory path.' };
    }
    try {
      const files = await store.list(context.userId);
      if (files.length === 0) {
        return { success: true, data: { files: [] }, display: 'No files in your inbox.' };
      }
      const display = files.map(f => `• ${f.fileName} (${f.size} bytes, ${f.createdAt})\n  key: ${f.key}`).join('\n');
      return { success: true, data: { files }, display: `${files.length} file(s):\n${display}` };
    } catch (err) {
      return { success: false, error: `Cannot list store: ${(err as Error).message}` };
    }
  }

  private async deleteFromStore(key: string, context: SkillContext): Promise<SkillResult> {
    const store = context.fileStore;
    if (!store) {
      return this.deleteFile(this.resolvePath(key));
    }
    try {
      const deleted = await store.delete(key, context.userId);
      return deleted
        ? { success: true, data: { key }, display: `Deleted from store: ${key}` }
        : { success: false, error: `Key "${key}" not found in store` };
    } catch (err) {
      return { success: false, error: `Cannot delete store key "${key}": ${(err as Error).message}` };
    }
  }

  private deleteFile(filePath: string): SkillResult {
    try {
      if (!fs.existsSync(filePath)) {
        return { success: false, error: `"${filePath}" does not exist` };
      }
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        return { success: false, error: `"${filePath}" is a directory. Use shell for directory deletion.` };
      }
      fs.unlinkSync(filePath);
      return {
        success: true,
        data: { path: filePath },
        display: `Deleted ${filePath}`,
      };
    } catch (err) {
      return { success: false, error: `Cannot delete "${filePath}": ${(err as Error).message}` };
    }
  }
}
