import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type ProviderCallLedgerStatus =
  | "allowed"
  | "completed"
  | "blocked"
  | "failed";

export interface ProviderCallLedgerEntry {
  callId: string;
  runId: string;
  customerId?: string;
  specId?: string;
  provider: string;
  model: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  actualCostUsd?: number;
  status: ProviderCallLedgerStatus;
  blockReason?: string;
  createdAt: string;
}

function lineToEntry(line: string): ProviderCallLedgerEntry | null {
  const t = line.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as ProviderCallLedgerEntry;
  } catch {
    return null;
  }
}

export async function readProviderCallLedger(
  filePath: string,
): Promise<ProviderCallLedgerEntry[]> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return raw
      .split("\n")
      .map(lineToEntry)
      .filter((e): e is ProviderCallLedgerEntry => e !== null);
  } catch (e: unknown) {
    const err = e as { code?: string };
    if (err.code === "ENOENT") return [];
    throw e;
  }
}

export async function appendProviderCallLedgerEntry(
  filePath: string,
  entry: ProviderCallLedgerEntry,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const line = `${JSON.stringify(entry)}\n`;
  await appendFile(filePath, line, "utf-8");
}

/** Overwrite ledger file (e.g. demo reset). */
export async function writeProviderCallLedger(
  filePath: string,
  entries: ProviderCallLedgerEntry[],
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const body = entries.map((e) => JSON.stringify(e)).join("\n");
  await writeFile(filePath, body ? `${body}\n` : "", "utf-8");
}
