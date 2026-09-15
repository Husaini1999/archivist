import fs from "node:fs/promises";
import path from "node:path";
import { redact, safeSlug } from "../security/redact.js";

const documents = ["profile", "architecture", "decisions", "priorities", "technical-debt"] as const;

export class MemoryService {
  constructor(private readonly home: string) {}
  projectDir(slug: string) { return path.join(this.home, "memory", "projects", safeSlug(slug)); }

  async ensure(slug: string): Promise<string> {
    const dir = this.projectDir(slug);
    await fs.mkdir(path.join(dir, "history"), { recursive: true });
    await Promise.all(documents.map(async name => {
      const file = path.join(dir, `${name}.md`);
      try { await fs.access(file); } catch { await fs.writeFile(file, `# ${name.replace("-", " ")}\n\n`); }
    }));
    return dir;
  }

  async readRelevant(slug: string, names: string[] = ["profile", "architecture", "technical-debt", "priorities"]) {
    const dir = await this.ensure(slug);
    return Promise.all(names.filter(n => documents.includes(n as typeof documents[number])).map(async n => ({ name: n, content: await fs.readFile(path.join(dir, `${n}.md`), "utf8") })));
  }

  async write(slug: string, name: typeof documents[number], content: string) {
    await this.ensure(slug);
    await fs.writeFile(path.join(this.projectDir(slug), `${name}.md`), redact(content));
  }

  async appendHistory(slug: string, dateKey: string, section: "Analysis"|"Recommendation"|"Decision"|"Implementation"|"Validation"|"Git"|"Learning", content: string) {
    await this.ensure(slug);
    const file = path.join(this.projectDir(slug), "history", `${dateKey}.md`);
    let existing = "";
    try { existing = await fs.readFile(file, "utf8"); } catch { existing = `# ${dateKey}\n`; }
    await fs.writeFile(file, `${existing}\n## ${section}\n\n${redact(content)}\n`);
    return file;
  }
}
