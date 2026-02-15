import { hashJSON } from "./hashing";

export type IntegrityReceipt = {
  receipt_version: "1";
  engine: string;
  run_id: string;
  created_at: string;

  inputs: Record<string, any>;
  params: Record<string, any>;
  outputs: Record<string, any>;
  environment: Record<string, any>;

  prev_receipt_hash?: string;
  receipt_hash: string;
};

export function createReceipt(
  data: Omit<IntegrityReceipt, "receipt_version" | "receipt_hash">
): IntegrityReceipt {
  const base = { receipt_version: "1" as const, ...data };
  const receipt_hash = hashJSON(base);
  return { ...base, receipt_hash };
}
