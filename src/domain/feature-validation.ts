export interface FeatureValidationCheck {
  id: string;
  command: string;
}

export interface FeatureValidationChecks {
  happy: FeatureValidationCheck[];
  edge: FeatureValidationCheck[];
}

export function parseFeatureValidation(markdown: string, featureId: string): FeatureValidationChecks {
  const checks: FeatureValidationChecks = { happy: [], edge: [] };
  const validation = validationBlock(markdown);
  if (!validation) return checks;

  const seen = new Set<string>();
  const lines = validation.split(/\r?\n/);
  let section: keyof FeatureValidationChecks | undefined;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const subsection = /^###\s+(.+?)\s*$/.exec(line);
    if (subsection) {
      const name = subsection[1].trim().toLowerCase();
      section = name === "happy" || name === "edge" ? name : undefined;
      index++;
      continue;
    }

    const check = /^\s*-\s+check:\s*(.*?)\s*$/.exec(line);
    if (!check || !section) {
      index++;
      continue;
    }

    const id = check[1].trim();
    const entryLines: string[] = [];
    index++;
    while (index < lines.length && !/^###\s+/.test(lines[index]) && !/^\s*-\s+check:\s*/.test(lines[index])) {
      entryLines.push(lines[index]);
      index++;
    }

    const command = commandFromEntry(entryLines);
    if (!id || !command) continue;
    if (seen.has(id)) throw new Error(`Duplicate validation check id "${id}" in feature ${featureId}`);
    seen.add(id);
    checks[section].push({ id, command });
  }

  return checks;
}

function validationBlock(markdown: string): string | undefined {
  const lines = markdown.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Validation\s*$/.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return undefined;

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function commandFromEntry(lines: string[]): string | undefined {
  const parts: string[] = [];
  let inCommand = false;

  for (const line of lines) {
    const command = /^\s+command:\s*(.*?)\s*$/.exec(line);
    if (command) {
      parts.push(command[1]);
      inCommand = true;
      continue;
    }

    if (!inCommand) continue;
    if (!line.trim()) {
      parts.push("");
      continue;
    }
    parts.push(line.trim());
  }

  const command = parts.join("\n").trim();
  return command || undefined;
}
