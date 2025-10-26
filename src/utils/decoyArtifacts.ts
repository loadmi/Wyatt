// src/utils/decoyArtifacts.ts
import { promises as fs } from "fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export type DecoyTemplate = {
  id: string;
  label: string;
  type: "pdf" | "image";
  description?: string;
  defaults?: Record<string, string | (() => string)>;
};

export type DecoyArtifactRecord = {
  id: string;
  templateId: string;
  type: "pdf" | "image";
  filename: string;
  mimeType: string;
  path: string;
  createdAt: number;
  expiresAt: number;
  fields: Record<string, string>;
};

export type CreateDecoyOptions = {
  overrides?: Record<string, string>;
  ttlMs?: number;
};

export type DecoyArtifactView = Pick<DecoyArtifactRecord, "id" | "templateId" | "type" | "filename" | "mimeType" | "createdAt" | "expiresAt">;

const DEFAULT_TTL = 30 * 60 * 1000; // 30 minutes
const STORAGE_DIR = path.join(os.tmpdir(), "wyatt-decoys");

const templates: DecoyTemplate[] = [
  {
    id: "invoice-pdf",
    label: "Invoice (PDF)",
    type: "pdf",
    description: "Simple invoice with randomized totals and reference numbers.",
    defaults: {
      company: "Northwind Holdings",
      customer: "Acme Logistics",
      amount: () => `$${(1500 + Math.floor(Math.random() * 850)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      reference: () => `INV-${Math.floor(100000 + Math.random() * 900000)}`,
      dueDate: () => {
        const date = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
        return date.toISOString().slice(0, 10);
      },
    },
  },
  {
    id: "shipping-label",
    label: "Shipping Label (SVG)",
    type: "image",
    description: "Lightweight label with randomized tracking numbers and hubs.",
    defaults: {
      sender: "Hyperion Distribution",
      recipient: "Warehouse 42",
      tracking: () => `1Z${Math.random().toString(36).slice(2, 12).toUpperCase()}`,
      origin: "LAX Processing",
      destination: "Portland Hub",
    },
  },
];

const records = new Map<string, DecoyArtifactRecord>();
let cleanupTimer: NodeJS.Timeout | null = null;

function ensureCleanupTimer(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    void cleanupExpiredArtifacts().catch(error => {
      console.warn("Failed to cleanup decoy artifacts:", error instanceof Error ? error.message : error);
    });
  }, 5 * 60 * 1000);
  cleanupTimer.unref?.();
}

async function ensureStorageDir(): Promise<void> {
  try {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
  } catch (error) {
    console.warn("Failed to ensure decoy storage directory:", (error as any)?.message || error);
  }
}

function resolveFieldValue(value: string | (() => string)): string {
  if (typeof value === "function") {
    try {
      const resolved = value();
      return typeof resolved === "string" ? resolved : String(resolved ?? "");
    } catch (error) {
      console.warn("Failed to resolve decoy field value:", (error as any)?.message || error);
      return "";
    }
  }
  return value;
}

function getTemplate(id: string): DecoyTemplate | undefined {
  return templates.find(template => template.id === id);
}

function escapePdfText(text: string): string {
  return text.replace(/[\\()]/g, match => `\\${match}`);
}

function createPdfBuffer(fields: Record<string, string>): { buffer: Buffer; filename: string; mimeType: string } {
  const lines = [
    `Invoice: ${fields.reference || "INV-000000"}`,
    `Bill To: ${fields.customer || "Customer"}`,
    `Amount Due: ${fields.amount || "$0.00"}`,
    `Due Date: ${fields.dueDate || "N/A"}`,
    `Issued By: ${fields.company || "Company"}`,
  ];

  const contentLines: string[] = [
    "BT",
    "/F1 22 Tf",
    "50 760 Td (Decoy Invoice Document) Tj",
    "/F1 16 Tf",
    "0 -40 Td (Generated for operational use only) Tj",
  ];

  for (const line of lines) {
    contentLines.push("0 -28 Td (" + escapePdfText(line) + ") Tj");
  }
  contentLines.push("ET");

  const contentStream = contentLines.join("\n");
  const contentBuffer = Buffer.from(contentStream, "utf8");

  const objects = [
    { id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { id: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    {
      id: 3,
      body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    },
    {
      id: 4,
      body: `<< /Length ${contentBuffer.length} >>\nstream\n${contentStream}\nendstream`,
    },
    { id: 5, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = new Map<number, number>();
  let position = Buffer.byteLength(pdf, "utf8");
  const ordered = [...objects].sort((a, b) => a.id - b.id);

  for (const obj of ordered) {
    const chunk = `${obj.id} 0 obj\n${obj.body}\nendobj\n`;
    offsets.set(obj.id, position);
    pdf += chunk;
    position += Buffer.byteLength(chunk, "utf8");
  }

  const xrefStart = position;
  const maxId = Math.max(...ordered.map(o => o.id));
  const xrefEntries: string[] = new Array(maxId + 1).fill("0000000000 65535 f \n");
  for (const obj of ordered) {
    const offset = offsets.get(obj.id) ?? 0;
    xrefEntries[obj.id] = `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }

  const xref = `xref\n0 ${maxId + 1}\n${xrefEntries.join("")}`;
  pdf += xref;
  const trailer = `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  pdf += trailer;

  const base = fields.reference || "invoice";
  return { buffer: Buffer.from(pdf, "utf8"), filename: `${sanitizeFilename(base)}.pdf`, mimeType: "application/pdf" };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function createSvgBuffer(fields: Record<string, string>): { buffer: Buffer; filename: string; mimeType: string } {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="420" height="280" viewBox="0 0 420 280">\n  <style>\n    text { font-family: 'Segoe UI', sans-serif; fill: #1f2937; }\n    .label { font-size: 16px; font-weight: 600; }\n    .value { font-size: 14px; }\n    .badge { font-size: 20px; font-weight: bold; letter-spacing: 4px; }\n  </style>\n  <rect x="8" y="8" width="404" height="264" rx="12" ry="12" fill="#f8fafc" stroke="#cbd5f5" stroke-width="2"/>\n  <text x="24" y="48" class="label">Sender</text>\n  <text x="24" y="72" class="value">${escapeHtml(fields.sender || "Sender")}</text>\n  <text x="24" y="112" class="label">Recipient</text>\n  <text x="24" y="136" class="value">${escapeHtml(fields.recipient || "Recipient")}</text>\n  <text x="24" y="176" class="label">Origin</text>\n  <text x="24" y="200" class="value">${escapeHtml(fields.origin || "Origin")}</text>\n  <text x="220" y="176" class="label">Destination</text>\n  <text x="220" y="200" class="value">${escapeHtml(fields.destination || "Destination")}</text>\n  <rect x="220" y="48" width="172" height="96" rx="10" ry="10" fill="#e2e8f0"/>\n  <text x="230" y="92" class="label">Tracking</text>\n  <text x="230" y="126" class="badge">${escapeHtml(fields.tracking || "TRACK-0000")}</text>\n  <text x="24" y="240" class="value">Operational decoy artifact</text>\n</svg>`;
  const base = fields.tracking || "label";
  return { buffer: Buffer.from(svg, "utf8"), filename: `${sanitizeFilename(base)}.svg`, mimeType: "image/svg+xml" };
}

function sanitizeFilename(name: string): string {
  const trimmed = (name || "").trim();
  if (!trimmed) return "artifact";
  return trimmed.replace(/[^A-Za-z0-9._-]+/g, "-");
}

async function writeArtifactFile(filename: string, buffer: Buffer): Promise<{ id: string; filePath: string }> {
  await ensureStorageDir();
  const id = crypto.randomUUID();
  const safeName = sanitizeFilename(filename);
  const filePath = path.join(STORAGE_DIR, `${id}-${safeName}`);
  await fs.writeFile(filePath, buffer);
  return { id, filePath };
}

export function listDecoyTemplates(): DecoyTemplate[] {
  return templates.map(template => ({ ...template }));
}

export async function createDecoyArtifact(templateId: string, options: CreateDecoyOptions = {}): Promise<DecoyArtifactRecord> {
  const template = getTemplate(templateId);
  if (!template) {
    throw new Error(`Unknown decoy template: ${templateId}`);
  }

  const fields: Record<string, string> = {};
  if (template.defaults) {
    for (const [key, value] of Object.entries(template.defaults)) {
      fields[key] = resolveFieldValue(value)?.toString() ?? "";
    }
  }
  if (options.overrides) {
    for (const [key, value] of Object.entries(options.overrides)) {
      if (typeof value === "string") {
        fields[key] = value.trim();
      }
    }
  }

  const payload = template.type === "pdf" ? createPdfBuffer(fields) : createSvgBuffer(fields);
  const { id, filePath } = await writeArtifactFile(payload.filename, payload.buffer);
  const ttl = Number.isFinite(options.ttlMs) && (options.ttlMs ?? 0) > 0 ? Math.trunc(options.ttlMs!) : DEFAULT_TTL;
  const createdAt = Date.now();
  const expiresAt = createdAt + ttl;

  const record: DecoyArtifactRecord = {
    id,
    templateId: template.id,
    type: template.type,
    filename: payload.filename,
    mimeType: payload.mimeType,
    path: filePath,
    createdAt,
    expiresAt,
    fields,
  };

  records.set(id, record);
  ensureCleanupTimer();
  return record;
}

export function listDecoyArtifacts(): DecoyArtifactView[] {
  const now = Date.now();
  return Array.from(records.values())
    .filter(record => record.expiresAt > now)
    .map(record => ({
      id: record.id,
      templateId: record.templateId,
      type: record.type,
      filename: record.filename,
      mimeType: record.mimeType,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function getDecoyArtifact(id: string): DecoyArtifactRecord | null {
  const record = records.get(id);
  if (!record) return null;
  if (record.expiresAt <= Date.now()) {
    void removeDecoyArtifact(id).catch(() => {});
    return null;
  }
  return record;
}

export async function removeDecoyArtifact(id: string): Promise<void> {
  const record = records.get(id);
  if (!record) return;
  records.delete(id);
  try {
    await fs.unlink(record.path);
  } catch (error) {
    if ((error as any)?.code !== "ENOENT") {
      console.warn("Failed to remove decoy artifact:", (error as any)?.message || error);
    }
  }
}

export async function cleanupExpiredArtifacts(): Promise<void> {
  const now = Date.now();
  const expired = Array.from(records.values()).filter(record => record.expiresAt <= now);
  await Promise.all(expired.map(record => removeDecoyArtifact(record.id)));
}

export function getDecoyStoragePath(): string {
  return STORAGE_DIR;
}

