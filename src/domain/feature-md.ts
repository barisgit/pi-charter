export interface FeatureDefinition {
  id: string;
  milestone: string;
  order: number;
  fulfills: string[];
  preconditions: string[];
  body: string;
}

export function parseFeatureMarkdown(markdown: string): FeatureDefinition {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/m.exec(markdown);
  if (!match) throw new Error("Feature markdown must start with YAML frontmatter");
  const fields = parseFrontmatter(match[1]);
  const id = stringField(fields, "id");
  const milestone = stringField(fields, "milestone");
  return {
    id,
    milestone,
    order: numberField(fields, "order"),
    fulfills: arrayField(fields, "fulfills"),
    preconditions: arrayField(fields, "preconditions"),
    body: match[2].trim(),
  };
}

function parseFrontmatter(text: string): Map<string, string | string[]> {
  const fields = new Map<string, string | string[]>();
  const lines = text.split(/\r?\n/);
  let currentArrayKey: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const arrayItem = /^\s*-\s+(.*?)\s*$/.exec(rawLine);
    if (arrayItem && currentArrayKey) {
      const current = fields.get(currentArrayKey);
      const arr = Array.isArray(current) ? current : [];
      arr.push(arrayItem[1]);
      fields.set(currentArrayKey, arr);
      continue;
    }

    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const value = match[2];
    currentArrayKey = undefined;

    if (value === "[]") {
      fields.set(key, []);
      continue;
    }
    if (value === "") {
      fields.set(key, []);
      currentArrayKey = key;
      continue;
    }
    fields.set(key, value);
  }
  return fields;
}

function stringField(fields: Map<string, string | string[]>, key: string): string {
  const value = fields.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error(`Feature frontmatter missing ${key}`);
  return value.trim();
}

function numberField(fields: Map<string, string | string[]>, key: string): number {
  const value = stringField(fields, key);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Feature frontmatter ${key} must be a number`);
  return parsed;
}

function arrayField(fields: Map<string, string | string[]>, key: string): string[] {
  const value = fields.get(key);
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "[]") return [];
    return trimmed
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map((item) => item.trim().replace(/^['\"]|['\"]$/g, ""))
      .filter(Boolean);
  }
  return [];
}
