import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Stores } from "./stores.js";
import type { FileRecord } from "./types.js";

const MIME: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json",
  ".csv": "text/csv",
};

export class FileOutbox {
  constructor(
    private outboxDir: string,
    private files: Stores["files"],
  ) {}

  save(sessionId: string, srcPath: string, caption?: string): FileRecord {
    const stat = fs.statSync(srcPath); // throws if missing
    if (!stat.isFile()) throw new Error(`not a file: ${srcPath}`);
    const id = crypto.randomUUID();
    const ext = path.extname(srcPath).toLowerCase();
    const storedPath = path.join(this.outboxDir, `${id}${ext}`);
    fs.copyFileSync(srcPath, storedPath);
    const rec: FileRecord = {
      id,
      sessionId,
      originalPath: srcPath,
      storedPath,
      mime: MIME[ext] ?? "application/octet-stream",
      caption: caption ?? null,
      createdAt: new Date().toISOString(),
    };
    this.files.insert(rec);
    return rec;
  }

  /** Stores an in-memory byte buffer as-is (persists images the user sent) */
  saveData(sessionId: string, data: Buffer, mime: string, caption?: string): FileRecord {
    const id = crypto.randomUUID();
    const ext = Object.keys(MIME).find((k) => MIME[k] === mime) ?? "";
    const storedPath = path.join(this.outboxDir, `${id}${ext}`);
    fs.writeFileSync(storedPath, data);
    const rec: FileRecord = {
      id,
      sessionId,
      originalPath: storedPath,
      storedPath,
      mime,
      caption: caption ?? null,
      createdAt: new Date().toISOString(),
    };
    this.files.insert(rec);
    return rec;
  }

  get(fileId: string): FileRecord | null {
    return this.files.get(fileId);
  }
}
