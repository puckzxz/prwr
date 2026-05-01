export interface ProcfileEntry {
  name: string;
  command: string;
  line: number;
}

export function parseProcfile(source: string): ProcfileEntry[] {
  const entries: ProcfileEntry[] = [];
  const names = new Set<string>();
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const rawLine = lines[index] ?? "";
    const line = rawLine.trim();

    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const separator = rawLine.indexOf(":");
    if (separator === -1) {
      throw new Error(`Invalid Procfile line ${lineNumber}: expected "name: command".`);
    }

    const name = rawLine.slice(0, separator).trim();
    const command = rawLine.slice(separator + 1).trim();

    validateProcessName(name, `Procfile line ${lineNumber}`);

    if (command.length === 0) {
      throw new Error(`Invalid Procfile line ${lineNumber}: command is required.`);
    }

    if (names.has(name)) {
      throw new Error(`Invalid Procfile line ${lineNumber}: duplicate process "${name}".`);
    }

    names.add(name);
    entries.push({ name, command, line: lineNumber });
  }

  if (entries.length === 0) {
    throw new Error("Procfile does not define any processes.");
  }

  return entries;
}

export function validateProcessName(name: string, context = "process name"): void {
  if (name.length === 0) {
    throw new Error(`Invalid ${context}: process name is required.`);
  }

  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error(
      `Invalid ${context}: "${name}" may only contain letters, numbers, dots, underscores, and dashes.`
    );
  }
}
