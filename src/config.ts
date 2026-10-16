import { z } from "zod";

const Schema = z.object({
  META_ACCESS_TOKEN: z.string().min(1),
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v25.0"),
  META_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  META_WRITE_ALLOWLIST: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^act_\d+$/))),
});

export interface Config {
  accessToken: string;
  graphVersion: string;
  timeoutMs: number;
  writeAllowlist: string[];
}

/** Validate environment variables. Error text names fields only, never values. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const r = Schema.safeParse(env);
  if (!r.success) {
    const detail = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration (${detail})`);
  }
  const v = r.data;
  return {
    accessToken: v.META_ACCESS_TOKEN,
    graphVersion: v.META_GRAPH_VERSION,
    timeoutMs: v.META_TIMEOUT_MS,
    writeAllowlist: v.META_WRITE_ALLOWLIST,
  };
}
