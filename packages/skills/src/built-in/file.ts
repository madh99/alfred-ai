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
    description:
      'Read, write, move, copy, or send files. Use for reading file contents, writing text to files, ' +
      'saving binary data, listing directory contents, moving/copying files, or getting file info. ' +
      'Use "send" to deliver a file to the user in the chat (PDF, images, etc.). ' +
      'Prefer this over shell for file operations. ' +
      'When a user sends a file attachment, it is saved to the inbox — use "move" to relocate it.',
    riskLevel: 'write',
    version: '2.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'write', 'write_binary', 'append', 'list', 'info', 'exists', 'move', 'copy', 'delete', 'send'],
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
      return { success: false, error: `Missing "content" field for "${action}" action. You must provide the file content.` };
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
      case 'send': return this.sendFile(resolvedPath);
      default:
        return { success: false, error: `Unknown action "${action}". Valid: read, write, write_binary, append, list, info, exists, move, copy, delete, send` };
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

  private sendFile(filePath: string): SkillResult {
    try {
      if (!fs.existsSync(filePath)) {
        return { success: false, error: `"${filePath}" does not exist` };
      }
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        return { success: false, error: `"${filePath}" is a directory, not a file` };
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
