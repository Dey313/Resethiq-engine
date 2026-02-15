import crypto from "node:crypto";

function h(data: Buffer) {
  return crypto.createHash("blake2b512").update(data).digest();
}

export function merkleRootFromLeafHex(leafHex: string[]): { root_hex: string; leaf_count: number } {
  if (leafHex.length === 0) {
    return { root_hex: h(Buffer.from("resethiq:empty")).toString("hex"), leaf_count: 0 };
  }
  let level = leafHex.map((x) => Buffer.from(x, "hex"));
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? level[i];
      next.push(h(Buffer.concat([left, right])));
    }
    level = next;
  }
  return { root_hex: level[0].toString("hex"), leaf_count: leafHex.length };
}

type Node = Buffer;
type Level = Node[];

function buildLevels(leafHex: string[]): Level[] {
  const levels: Level[] = [];
  let level: Level = leafHex.map((x) => Buffer.from(x, "hex"));
  if (level.length === 0) return [[h(Buffer.from("resethiq:empty"))]];
  levels.push(level);

  while (level.length > 1) {
    const next: Node[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? level[i];
      next.push(h(Buffer.concat([left, right])));
    }
    level = next;
    levels.push(level);
  }
  return levels;
}

export type MerkleProof = {
  index: number;         // leaf index
  leaf_hex: string;      // leaf hash hex
  siblings_hex: string[];// sibling nodes from bottom->top
};

export function merkleProof(leafHex: string[], index: number): MerkleProof {
  if (leafHex.length === 0) {
    throw new Error("Cannot build proof for empty tree");
  }
  if (index < 0 || index >= leafHex.length) {
    throw new Error("Proof index out of range");
  }

  const levels = buildLevels(leafHex);
  const siblings: string[] = [];

  let idx = index;
  for (let level = 0; level < levels.length - 1; level++) {
    const nodes = levels[level];
    const isRight = idx % 2 === 1;
    const pairIdx = isRight ? idx - 1 : idx + 1;
    const sibling = nodes[pairIdx] ?? nodes[idx]; // dup last if odd
    siblings.push(sibling.toString("hex"));
    idx = Math.floor(idx / 2);
  }

  return {
    index,
    leaf_hex: leafHex[index],
    siblings_hex: siblings,
  };
}

// Deterministic verification of a proof against a root
export function verifyProof(rootHex: string, proof: MerkleProof): boolean {
  let node = Buffer.from(proof.leaf_hex, "hex");
  let idx = proof.index;

  for (const sibHex of proof.siblings_hex) {
    const sib = Buffer.from(sibHex, "hex");
    const isRight = idx % 2 === 1;
    node = isRight ? h(Buffer.concat([sib, node])) : h(Buffer.concat([node, sib]));
    idx = Math.floor(idx / 2);
  }
  return node.toString("hex") === rootHex;
}
