import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

export type PermissionAction = "allow" | "ask" | "deny";

const permissionFileSchema = z.object({
  permissions: z.record(z.string(), z.enum(["allow", "ask", "deny"])).default({}),
}).strict();

const defaultPermissions: Record<string, PermissionAction> = {
  read: "allow",
  glob: "allow",
  grep: "allow",
  edit_file: "ask",
  bash: "ask",
  webfetch: "allow",
};

export async function loadPermissions(): Promise<Record<string, PermissionAction>> {
  const root = resolve(Bun.env.AGENT_ROOT ?? process.cwd());
  const configPath = resolve(root, "coding-agent.json");
  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaultPermissions };
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`Invalid JSON in ${configPath}.`);
  }

  const config = permissionFileSchema.parse(parsed);
  return { ...defaultPermissions, ...config.permissions };
}
