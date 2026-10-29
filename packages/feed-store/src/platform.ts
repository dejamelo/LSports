import {
  defaultLimits,
  validateLimits,
  effectiveLimits,
  withinPolicy,
  type BetLimits,
  type LimitPolicy,
} from "./operation-limits.js";
import {
  currency,
  minor,
  type Currency,
  type OperationScope,
  type IntegrationChannel,
} from "@lsports/contracts";
import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  randomUUID,
  createHash,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import {
  mkdirSync,
  chmodSync,
  existsSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { root } from "./index.js";
import { defaultSportsbookTheme, validateSportsbookTheme, ThemeValidationError, type SportsbookTheme } from "./sportsbook-theme.js";
export const ADMIN_IDLE_TIMEOUT_MS=300000;
const scrypt = promisify(scryptCallback);
export function platformEnabled() {
  const value = process.env.PLATFORM_ENABLED ?? "false";
  if (!["true", "false"].includes(value))
    throw new Error("PLATFORM_ENABLED must be true or false");
  return value === "true";
}
export const platformDirectory = () =>
  resolve(root, process.env.PLATFORM_DATA_DIR || ".runtime/platform");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
export type Role = "platform_admin" | "client_admin";
export interface Admin {
  id: string;
  email: string;
  role: Role;
  clientId: string | null;
}
export interface ClientSettings {
  acceptingTickets: boolean;
  displayName: string;
  locale: "es-AR";
}
export interface Client {
  id: string;
  name: string;
  status: "active" | "suspended";
  domains: string[];
  settings: ClientSettings;
  createdAt: string;
}
export interface Operation extends OperationScope {
  id: string;
  name: string;
  country: string;
  status: "active" | "suspended";
  acceptingTickets: boolean;
  clientMayEditLimits: boolean;
  limits: BetLimits;
  createdAt: string;
}
export function assertBinding(
  scope: OperationScope,
  input: Record<string, unknown>,
  required = false,
) {
  for (const field of ["clientId", "operationId", "currency"] as const)
    if (
      (required || input[field] !== undefined) &&
      input[field] !== scope[field]
    )
      throw new PlatformError(
        "SCOPE_MISMATCH",
        "Cliente, operación o moneda no coinciden con la credencial o sesión.",
        403,
      );
}
export function integrationChannel(
  channel: unknown = "web",
  terminal: unknown = undefined,
): { channel: IntegrationChannel; terminalId?: string } {
  if (!["web", "mobile", "pos"].includes(String(channel)))
    throw new PlatformError(
      "INVALID_CHANNEL",
      "Canal inválido: web, mobile o pos.",
    );
  if (channel === "pos") {
    if (
      typeof terminal !== "string" ||
      !/^[a-zA-Z0-9:_-]{8,128}$/.test(terminal)
    )
      throw new PlatformError(
        "INVALID_TERMINAL",
        "POS requiere un terminal de 8–128 caracteres.",
      );
    return { channel: "pos", terminalId: terminal };
  }
  if (terminal !== undefined)
    throw new PlatformError(
      "INVALID_TERMINAL",
      "El terminal corresponde únicamente al canal POS.",
    );
  return { channel: channel as IntegrationChannel };
}
export class PlatformError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function text(value: unknown, field: string, max = 150) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new PlatformError("INVALID_INPUT", `Revisá el campo ${field}.`);
  return value.trim();
}
export function origins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 30)
    throw new PlatformError(
      "INVALID_DOMAINS",
      "Ingresá hasta 30 orígenes exactos.",
    );
  return [
    ...new Set(
      value.map((item) => {
        const raw = text(item, "dominio", 250);
        let url: URL;
        try {
          url = new URL(raw);
        } catch {
          throw new PlatformError("INVALID_DOMAINS", "Origen inválido.");
        }
        if (
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !["https:", "http:"].includes(url.protocol) ||
          (url.protocol === "http:" &&
            !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ||
          url.origin !== raw ||
          /[\s*;'"\\]/.test(raw)
        )
          throw new PlatformError(
            "INVALID_DOMAINS",
            "Usá un origen HTTPS exacto, sin ruta ni comodines. HTTP solo para localhost.",
          );
        return url.origin;
      }),
    ),
  ];
}
const email = (v: unknown) => {
  const result = text(v, "email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result))
    throw new PlatformError("INVALID_EMAIL", "Email inválido.");
  return result;
};
async function passwordHash(value: unknown) {
  if (typeof value !== "string" || value.length < 12 || value.length > 256)
    throw new PlatformError(
      "PASSWORD_POLICY",
      "La contraseña debe tener entre 12 y 256 caracteres.",
    );
  const salt = token();
  const hash = (await scrypt(value, salt, 64)) as Buffer;
  return `${salt}:${hash.toString("hex")}`;
}
async function checkPassword(password: string, stored: string) {
  const [salt, expected] = stored.split(":");
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return timingSafeEqual(hash, Buffer.from(expected, "hex"));
}
const dummyHash = `${"a".repeat(43)}:${"0".repeat(128)}`;
export class PlatformStore {
  private db: DatabaseSync;
  constructor(
    public directory = platformDirectory(),
    readOnly = false,
    private now = () => Date.now(),
  ) {
    const path = join(directory, "control.sqlite");
    if (!readOnly) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    this.db = new DatabaseSync(path, { readOnly });
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    if (readOnly) return;
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL,domains TEXT NOT NULL,settings TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_terminals(operation_id TEXT NOT NULL REFERENCES operations(id),terminal_id TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(operation_id,terminal_id));
      CREATE TABLE IF NOT EXISTS admins(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL,client_id TEXT REFERENCES clients(id));
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES admins(id),csrf_hash TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,client_id TEXT NOT NULL REFERENCES clients(id),name TEXT NOT NULL,country TEXT NOT NULL,currency TEXT NOT NULL,status TEXT NOT NULL,accepting INTEGER NOT NULL,client_edits INTEGER NOT NULL,limits TEXT NOT NULL,created TEXT NOT NULL,UNIQUE(id,client_id,currency));
      CREATE TABLE IF NOT EXISTS client_limit_policies(client_id TEXT NOT NULL REFERENCES clients(id),currency TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(client_id,currency));
      CREATE TABLE IF NOT EXISTS operation_credentials(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,client_id TEXT NOT NULL,currency TEXT NOT NULL,name TEXT NOT NULL,hash TEXT UNIQUE NOT NULL,created TEXT NOT NULL,revoked TEXT,FOREIGN KEY(operation_id,client_id,currency) REFERENCES operations(id,client_id,currency));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,actor TEXT NOT NULL,client_id TEXT,action TEXT NOT NULL,details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_embeds(hash TEXT PRIMARY KEY,operation_id TEXT NOT NULL,client_id TEXT NOT NULL,currency TEXT NOT NULL,player_id TEXT NOT NULL,parent_origin TEXT NOT NULL,channel TEXT NOT NULL,terminal_id TEXT,expires INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0,FOREIGN KEY(operation_id,client_id,currency) REFERENCES operations(id,client_id,currency));
      CREATE TABLE IF NOT EXISTS operation_sessions(hash TEXT PRIMARY KEY,operation_id TEXT NOT NULL,client_id TEXT NOT NULL,currency TEXT NOT NULL,player_id TEXT NOT NULL,channel TEXT NOT NULL,terminal_id TEXT,expires INTEGER NOT NULL,credential_id TEXT NOT NULL REFERENCES operation_credentials(id),FOREIGN KEY(operation_id,client_id,currency) REFERENCES operations(id,client_id,currency));
      CREATE TABLE IF NOT EXISTS operation_embed_keys(embed_hash TEXT PRIMARY KEY,credential_id TEXT NOT NULL REFERENCES operation_credentials(id));
      CREATE TABLE IF NOT EXISTS login_limits(key TEXT PRIMARY KEY,attempts INTEGER NOT NULL,reset_at INTEGER NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS client_sportsbook_themes(client_id TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,draft TEXT NOT NULL,published TEXT NOT NULL,revision INTEGER NOT NULL,updated TEXT NOT NULL);`);
    // Adopt the shorter idle policy for existing sessions once on opening.
    // Reads never renew; the worker never authenticates administrative sessions.
    this.db.prepare("UPDATE sessions SET expires=? WHERE expires>?").run(this.now()+ADMIN_IDLE_TIMEOUT_MS,this.now()+ADMIN_IDLE_TIMEOUT_MS);
  }
  close() {
    this.db.close();
  }
  private transaction<T>(fn: () => T) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private audit(
    actor: string,
    clientId: string | null,
    action: string,
    details: Record<string, unknown> = {},
  ) {
    this.db
      .prepare(
        "INSERT INTO audit(at,actor,client_id,action,details) VALUES(?,?,?,?,?)",
      )
      .run(
        new Date(this.now()).toISOString(),
        actor,
        clientId,
        action,
        JSON.stringify(details),
      );
  }
  hasPlatformAdmin() {
    return !!this.db
      .prepare("SELECT id FROM admins WHERE role='platform_admin' LIMIT 1")
      .get();
  }
  async bootstrap(rawEmail: unknown, password: unknown) {
    const normalized = email(rawEmail);
    const hash = await passwordHash(password);
    return this.transaction(() => {
      if (this.hasPlatformAdmin())
        throw new PlatformError(
          "ALREADY_INITIALIZED",
          "El administrador ya existe.",
          409,
        );
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO admins VALUES(?,?,?,?,NULL)")
        .run(id, normalized, hash, "platform_admin");
      this.audit("bootstrap", null, "platform.admin.created", { adminId: id });
      return { id, email: normalized };
    });
  }
  async changePassword(
    actor: Admin,
    currentPassword: unknown,
    nextPassword: unknown,
  ) {
    const stored = this.db
      .prepare("SELECT password FROM admins WHERE id=?")
      .get(actor.id) as { password: string } | undefined;
    if (
      !stored ||
      typeof currentPassword !== "string" ||
      currentPassword.length > 256 ||
      !(await checkPassword(currentPassword, stored.password))
    )
      throw new PlatformError(
        "INVALID_PASSWORD",
        "La contraseña actual es incorrecta.",
        403,
      );
    const hash = await passwordHash(nextPassword);
    this.transaction(() => {
      this.db
        .prepare("UPDATE admins SET password=? WHERE id=?")
        .run(hash, actor.id);
      this.db.prepare("DELETE FROM sessions WHERE user_id=?").run(actor.id);
      this.audit(actor.id, actor.clientId, "auth.password.changed");
    });
  }
  async resetClientAccess(
    actor: Admin,
    clientId: string,
    nextPassword: unknown,
  ) {
    this.authorize(actor);
    this.authorize(actor, clientId);
    const target = this.db
      .prepare(
        "SELECT id FROM admins WHERE client_id=? AND role='client_admin'",
      )
      .get(clientId) as { id: string } | undefined;
    if (!target)
      throw new PlatformError("NOT_FOUND", "Administrador no encontrado.", 404);
    const hash = await passwordHash(nextPassword);
    this.transaction(() => {
      this.db
        .prepare("UPDATE admins SET password=? WHERE id=?")
        .run(hash, target.id);
      this.db.prepare("DELETE FROM sessions WHERE user_id=?").run(target.id);
      this.audit(actor.id, clientId, "auth.access.reset", {
        adminId: target.id,
      });
    });
  }
  // Operator-only CLI recovery; deliberately not exposed as an HTTP endpoint.
  async recoverPlatformAccess(rawEmail: unknown, nextPassword: unknown) {
    const normalized = email(rawEmail),
      target = this.db
        .prepare(
          "SELECT id FROM admins WHERE email=? AND role='platform_admin'",
        )
        .get(normalized) as { id: string } | undefined;
    if (!target)
      throw new PlatformError("NOT_FOUND", "Administrador no encontrado.", 404);
    const hash = await passwordHash(nextPassword);
    this.transaction(() => {
      this.db
        .prepare("UPDATE admins SET password=? WHERE id=?")
        .run(hash, target.id);
      this.db.prepare("DELETE FROM sessions WHERE user_id=?").run(target.id);
      this.audit("local_operator", null, "auth.access.recovered", {
        adminId: target.id,
      });
    });
  }
  terminals(actor: Admin, clientId: string, operationId: string) {
    this.authorizeOperation(actor, clientId, operationId);
    return this.db
      .prepare(
        "SELECT terminal_id as id,name,status FROM operation_terminals WHERE operation_id=? ORDER BY name",
      )
      .all(operationId);
  }
  saveTerminal(
    actor: Admin,
    clientId: string,
    operationId: string,
    input: Record<string, unknown>,
  ) {
    this.authorizeOperation(actor, clientId, operationId);
    const id = integrationChannel("pos", input.id).terminalId!,
      name = text(input.name, "nombre de terminal");
    if (!["active", "suspended"].includes(String(input.status)))
      throw new PlatformError("INVALID_STATUS", "Estado inválido.");
    return this.transaction(() => {
      const before = this.db
        .prepare(
          "SELECT name,status FROM operation_terminals WHERE operation_id=? AND terminal_id=?",
        )
        .get(operationId, id);
      this.db
        .prepare(
          "INSERT INTO operation_terminals VALUES(?,?,?,?) ON CONFLICT(operation_id,terminal_id) DO UPDATE SET name=excluded.name,status=excluded.status",
        )
        .run(operationId, id, name, String(input.status));
      this.audit(actor.id, clientId, "terminal.updated", {
        operationId,
        terminalId: id,
        before: before || null,
        after: { name, status: input.status },
      });
      return { id, name, status: input.status };
    });
  }
  assertTerminal(operationId: string, terminalId: string) {
    const managed = this.db
      .prepare("SELECT 1 FROM operation_terminals WHERE operation_id=? LIMIT 1")
      .get(operationId);
    if (!managed) return; // Existing integrations retain their pre-registry contract.
    const row = this.db
      .prepare(
        "SELECT status FROM operation_terminals WHERE operation_id=? AND terminal_id=?",
      )
      .get(operationId, terminalId);
    if (row?.status !== "active")
      throw new PlatformError(
        "TERMINAL_UNAVAILABLE",
        "Terminal no registrado o suspendido para esta operación.",
        403,
      );
  }
  preview(
    actor: Admin,
    clientId: string,
    operationId: string,
    parentOrigin: string,
    input: Record<string, unknown>,
  ) {
    const op = this.authorizeOperation(actor, clientId, operationId);
    assertBinding(op, input);
    const key = this.db
      .prepare(
        "SELECT id FROM operation_credentials WHERE operation_id=? AND revoked IS NULL ORDER BY created DESC LIMIT 1",
      )
      .get(op.id) as { id: string } | undefined;
    if (!key)
      throw new PlatformError(
        "CREDENTIAL_REQUIRED",
        "Creá una credencial vigente para abrir el iframe.",
        409,
      );
    const session = this.createEmbed(
      { ...op, credentialId: key.id, kind: "server" },
      {
        clientId,
        operationId,
        currency: op.currency,
        playerId: "control-demo:" + actor.id,
        parentOrigin,
        channel: input.channel ?? "web",
        ...(input.terminalId !== undefined
          ? { terminalId: input.terminalId }
          : {}),
      },
    );
    this.audit(actor.id, clientId, "embed.preview.created", {
      operationId,
      currency: op.currency,
    });
    return session;
  }
  private rateLimit(key: string) {
    const k = digest(key);
    const row = this.db
      .prepare("SELECT attempts,reset_at FROM login_limits WHERE key=?")
      .get(k) as { attempts: number; reset_at: number } | undefined;
    if (row && row.reset_at > this.now() && row.attempts >= 10)
      throw new PlatformError(
        "RATE_LIMITED",
        "Demasiados intentos. Esperá 15 minutos.",
        429,
      );
    this.db
      .prepare(
        "INSERT INTO login_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN reset_at<=? THEN 1 ELSE attempts+1 END,reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END",
      )
      .run(k, this.now() + 900000, this.now(), this.now());
  }
  async login(rawEmail: unknown, rawPassword: unknown, remote: string) {
    this.rateLimit(`ip:${remote}`);
    const normalized =
      typeof rawEmail === "string"
        ? rawEmail.slice(0, 254).toLowerCase().trim()
        : "";
    this.rateLimit(`email:${normalized}`);
    const row = this.db
      .prepare("SELECT * FROM admins WHERE email=?")
      .get(normalized) as { id: string; password: string } | undefined;
    const password =
      typeof rawPassword === "string" && rawPassword.length <= 256
        ? rawPassword
        : "";
    if (!(await checkPassword(password, row?.password || dummyHash)) || !row) {
      this.audit("anonymous", null, "auth.login.rejected");
      throw new PlatformError(
        "INVALID_LOGIN",
        "Email o contraseña incorrectos.",
        401,
      );
    }
    const value = token(),
      csrf = digest(`csrf:${value}`);
    this.transaction(() => {
      this.db.prepare("DELETE FROM sessions WHERE expires<=?").run(this.now());
      this.db
        .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
        .run(digest(value), row.id, digest(csrf), this.now() + ADMIN_IDLE_TIMEOUT_MS);
      this.audit(row.id, this.admin(row.id)!.clientId, "auth.login");
    });
    return { value, csrf, admin: this.admin(row.id)!, expiresAt:this.now()+ADMIN_IDLE_TIMEOUT_MS,syncId:digest(`sync:${value}`),serverNow:this.now() };
  }
  private admin(id: string): Admin | undefined {
    const row = this.db
      .prepare(
        "SELECT id,email,role,client_id as clientId FROM admins WHERE id=?",
      )
      .get(id);
    return row as unknown as Admin | undefined;
  }
  session(value: string) {
    const row = this.db
      .prepare(
        "SELECT user_id,csrf_hash,expires FROM sessions WHERE hash=? AND expires>?",
      )
      .get(digest(value), this.now()) as
      | { user_id: string; csrf_hash: string; expires:number }
      | undefined;
    return row
      ? { admin: this.admin(row.user_id)!, csrfHash: row.csrf_hash,expiresAt:row.expires,syncId:digest(`sync:${value}`),serverNow:this.now() }
      : undefined;
  }
  recordSessionActivity(value:string){
    const now=this.now();
    const updated=this.db.prepare("UPDATE sessions SET expires=? WHERE hash=? AND expires>?").run(now+ADMIN_IDLE_TIMEOUT_MS,digest(value),now);
    if(!updated.changes)throw new PlatformError("AUTH_REQUIRED","Tu sesión venció. Iniciá sesión nuevamente.",401);
    return this.session(value)!;
  }
  logout(value: string, actor: Admin) {
    this.transaction(() => {
      this.db.prepare("DELETE FROM sessions WHERE hash=?").run(digest(value));
      this.audit(actor.id, actor.clientId, "auth.logout");
    });
  }
  authorize(admin: Admin, clientId?: string) {
    // Never trust role or tenant supplied in a request/session payload.
    const current = this.admin(admin.id);
    if (
      !current ||
      current.role !== admin.role ||
      current.clientId !== admin.clientId ||
      (current.role !== "platform_admin" &&
        (!clientId || clientId !== current.clientId))
    )
      throw new PlatformError(
        "FORBIDDEN",
        "No tenés permiso para esta operación.",
        403,
      );
  }
  private checkedTheme(value: unknown): SportsbookTheme {
    try { return validateSportsbookTheme(value); }
    catch (error) {
      if (error instanceof ThemeValidationError) throw new PlatformError(error.code, error.message, 400);
      throw error;
    }
  }
  sportsbookTheme(actor: Admin, clientId: string) {
    this.authorize(actor, clientId);
    if (!this.client(clientId)) throw new PlatformError("CLIENT_NOT_FOUND", "Cliente no encontrado.", 404);
    const row = this.db.prepare("SELECT draft,published,revision,updated FROM client_sportsbook_themes WHERE client_id=?").get(clientId) as {draft:string;published:string;revision:number;updated:string}|undefined;
    return row ? { clientId, draft: JSON.parse(row.draft), published: JSON.parse(row.published), revision: Number(row.revision), updatedAt: row.updated } : { clientId, draft: { ...defaultSportsbookTheme }, published: { ...defaultSportsbookTheme }, revision: 0, updatedAt: null };
  }
  publishedSportsbookTheme(clientId: string): SportsbookTheme {
    const row = this.db.prepare("SELECT published FROM client_sportsbook_themes WHERE client_id=?").get(clientId) as {published:string}|undefined;
    if (!row) return { ...defaultSportsbookTheme };
    try { return this.checkedTheme(JSON.parse(row.published)); }
    catch { return { ...defaultSportsbookTheme }; }
  }
  saveSportsbookThemeDraft(actor: Admin, clientId: string, input: unknown) {
    this.authorize(actor, clientId);
    const draft = this.checkedTheme(input);
    if (!this.client(clientId)) throw new PlatformError("CLIENT_NOT_FOUND", "Cliente no encontrado.", 404);
    return this.transaction(() => {
      const current = this.sportsbookTheme(actor, clientId);
      const revision = current.revision + 1, updated = new Date(this.now()).toISOString();
      this.db.prepare("INSERT INTO client_sportsbook_themes(client_id,draft,published,revision,updated) VALUES(?,?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET draft=excluded.draft,revision=excluded.revision,updated=excluded.updated").run(clientId, JSON.stringify(draft), JSON.stringify(current.published), revision, updated);
      this.audit(actor.id, clientId, "sportsbook.theme.draft", { revision });
      return this.sportsbookTheme(actor, clientId);
    });
  }
  publishSportsbookTheme(actor: Admin, clientId: string, input?: unknown) {
    this.authorize(actor, clientId);
    const supplied = input === undefined ? undefined : this.checkedTheme(input);
    if (!this.client(clientId)) throw new PlatformError("CLIENT_NOT_FOUND", "Cliente no encontrado.", 404);
    return this.transaction(() => {
      const current = this.sportsbookTheme(actor, clientId), theme = supplied || current.draft, revision = current.revision + 1, updated = new Date(this.now()).toISOString();
      this.db.prepare("INSERT INTO client_sportsbook_themes(client_id,draft,published,revision,updated) VALUES(?,?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET draft=excluded.draft,published=excluded.published,revision=excluded.revision,updated=excluded.updated").run(clientId, JSON.stringify(theme), JSON.stringify(theme), revision, updated);
      this.audit(actor.id, clientId, "sportsbook.theme.published", { revision });
      return this.sportsbookTheme(actor, clientId);
    });
  }
  restoreDefaultSportsbookTheme(actor: Admin, clientId: string) {
    this.authorize(actor, clientId);
    if (!this.client(clientId)) throw new PlatformError("CLIENT_NOT_FOUND", "Cliente no encontrado.", 404);
    return this.transaction(() => {
      const theme = { ...defaultSportsbookTheme }, revision = this.sportsbookTheme(actor, clientId).revision + 1, updated = new Date(this.now()).toISOString();
      this.db.prepare("INSERT INTO client_sportsbook_themes(client_id,draft,published,revision,updated) VALUES(?,?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET draft=excluded.draft,published=excluded.published,revision=excluded.revision,updated=excluded.updated").run(clientId, JSON.stringify(theme), JSON.stringify(theme), revision, updated);
      this.audit(actor.id, clientId, "sportsbook.theme.default_restored", { revision });
      return this.sportsbookTheme(actor, clientId);
    });
  }
  clients(admin: Admin): Client[] {
    return (
      admin.role === "platform_admin"
        ? this.db.prepare("SELECT id FROM clients ORDER BY created").all()
        : this.db
            .prepare("SELECT id FROM clients WHERE id=?")
            .all(admin.clientId!)
    ).map((row) => this.client(String(row.id))!);
  }
  allClientIds(): string[] {
    return this.db
      .prepare("SELECT id FROM clients")
      .all()
      .map((row) => String(row.id));
  }
  client(id: string): Client | undefined {
    const row = this.db.prepare("SELECT * FROM clients WHERE id=?").get(id) as
      | {
          id: string;
          name: string;
          status: Client["status"];
          domains: string;
          settings: string;
          created: string;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          name: row.name,
          status: row.status,
          domains: JSON.parse(row.domains),
          settings: JSON.parse(row.settings),
          createdAt: row.created,
        }
      : undefined;
  }
  async createClient(actor: Admin, input: Record<string, unknown>) {
    this.authorize(actor);
    const name = text(input.name, "nombre");
    const normalized = email(input.adminEmail);
    const hash = await passwordHash(input.adminPassword);
    const domains = origins(input.domains || []);
    return this.transaction(() => {
      if (
        this.db.prepare("SELECT id FROM admins WHERE email=?").get(normalized)
      )
        throw new PlatformError(
          "EMAIL_EXISTS",
          "Ese email ya está registrado.",
          409,
        );
      const id = randomUUID(),
        adminId = randomUUID();
      this.db.prepare("INSERT INTO clients VALUES(?,?,?,?,?,?)").run(
        id,
        name,
        "active",
        JSON.stringify(domains),
        JSON.stringify({
          acceptingTickets: true,
          displayName: name,
          locale: "es-AR",
        }),
        new Date(this.now()).toISOString(),
      );
      this.db
        .prepare("INSERT INTO admins VALUES(?,?,?,?,?)")
        .run(adminId, normalized, hash, "client_admin", id);
      this.audit(actor.id, id, "client.created", { adminId });
      return this.client(id)!;
    });
  }
  updateClient(actor: Admin, id: string, input: Record<string, unknown>) {
    this.authorize(actor, id);
    const client = this.client(id);
    if (!client)
      throw new PlatformError("NOT_FOUND", "Cliente no encontrado.", 404);
    const previousDomains = JSON.stringify(client.domains);
    if (input.name !== undefined) client.name = text(input.name, "nombre");
    if (input.status !== undefined) {
      this.authorize(actor);
      if (!["active", "suspended"].includes(String(input.status)))
        throw new PlatformError("INVALID_STATUS", "Estado inválido.");
      client.status = input.status as Client["status"];
    }
    if (input.domains !== undefined) client.domains = origins(input.domains);
    if (input.settings !== undefined) {
      const settings = input.settings as Partial<ClientSettings>;
      if (
        !settings ||
        typeof settings !== "object" ||
        typeof settings.acceptingTickets !== "boolean" ||
        settings.locale !== "es-AR"
      )
        throw new PlatformError("INVALID_SETTINGS", "Configuración inválida.");
      client.settings = {
        acceptingTickets: settings.acceptingTickets,
        displayName: text(settings.displayName, "marca"),
        locale: "es-AR",
      };
    }
    return this.transaction(() => {
      this.db
        .prepare(
          "UPDATE clients SET name=?,status=?,domains=?,settings=? WHERE id=?",
        )
        .run(
          client.name,
          client.status,
          JSON.stringify(client.domains),
          JSON.stringify(client.settings),
          id,
        );
      if (
        input.domains !== undefined &&
        JSON.stringify(client.domains) !== previousDomains
      ) {
        this.db
          .prepare("DELETE FROM operation_sessions WHERE client_id=?")
          .run(id);
        this.db
          .prepare(
            "DELETE FROM operation_embed_keys WHERE embed_hash IN (SELECT hash FROM operation_embeds WHERE client_id=?)",
          )
          .run(id);
        this.db
          .prepare("DELETE FROM operation_embeds WHERE client_id=?")
          .run(id);
      }
      this.audit(actor.id, id, "client.updated", {
        fields: Object.keys(input).filter((k) =>
          ["status", "domains", "settings"].includes(k),
        ),
        status: client.status,
        acceptingTickets: client.settings.acceptingTickets,
        domains: client.domains,
        displayName: client.settings.displayName,
      });
      return client;
    });
  }
  operation(id: string): Operation | undefined {
    const row = this.db
      .prepare("SELECT * FROM operations WHERE id=?")
      .get(id) as
      | {
          id: string;
          client_id: string;
          name: string;
          country: string;
          currency: Currency;
          status: Operation["status"];
          accepting: number;
          client_edits: number;
          limits: string;
          created: string;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          operationId: row.id,
          clientId: row.client_id,
          name: row.name,
          country: row.country,
          currency: row.currency,
          status: row.status,
          acceptingTickets: !!row.accepting,
          clientMayEditLimits: !!row.client_edits,
          limits: JSON.parse(row.limits),
          createdAt: row.created,
        }
      : undefined;
  }
  allOperationIds(): string[] {
    return this.db
      .prepare("SELECT id FROM operations ORDER BY created,id")
      .all()
      .map((row) => String(row.id));
  }
  operations(actor: Admin, clientId: string) {
    this.authorize(actor, clientId);
    return this.allOperationIds()
      .map((id) => this.operation(id)!)
      .filter((op) => op.clientId === clientId);
  }
  authorizeOperation(actor: Admin, clientId: string, operationId: string) {
    this.authorize(actor, clientId);
    const op = this.operation(operationId);
    if (!op || op.clientId !== clientId)
      throw new PlatformError("NOT_FOUND", "Operación no encontrada.", 404);
    return op;
  }
  limitPolicy(clientId: string, code: Currency): LimitPolicy {
    const row = this.db
      .prepare(
        "SELECT body,revision FROM client_limit_policies WHERE client_id=? AND currency=?",
      )
      .get(clientId, code) as { body: string; revision: number } | undefined;
    return row
      ? { ...JSON.parse(row.body), revision: row.revision }
      : { ...defaultLimits, clientMayEdit: false, revision: 0 };
  }
  limitPolicies(actor: Admin, clientId: string) {
    this.authorize(actor, clientId);
    return Object.fromEntries(
      ["ARS", "CLP", "PYG", "USD", "VES"].map((code) => [
        code,
        this.limitPolicy(clientId, code as Currency),
      ]),
    );
  }
  updateLimitPolicy(
    actor: Admin,
    clientId: string,
    rawCurrency: unknown,
    input: Record<string, unknown>,
  ) {
    this.authorize(actor);
    if (!this.client(clientId))
      throw new PlatformError("NOT_FOUND", "Cliente no encontrado.", 404);
    const code = currency(rawCurrency),
      limits = validateLimits(input);
    if (typeof input.clientMayEdit !== "boolean")
      throw new PlatformError(
        "INVALID_POLICY",
        "Definí el permiso de edición del cliente.",
      );
    return this.transaction(() => {
      const previous = this.limitPolicy(clientId, code),
        next = {
          ...limits,
          clientMayEdit: input.clientMayEdit,
          revision: previous.revision + 1,
        };
      this.db
        .prepare(
          "INSERT INTO client_limit_policies VALUES(?,?,?,?) ON CONFLICT(client_id,currency) DO UPDATE SET body=excluded.body,revision=excluded.revision",
        )
        .run(clientId, code, JSON.stringify(next), next.revision);
      this.audit(actor.id, clientId, "limits.policy.updated", {
        currency: code,
        previous,
        next,
      });
      return next;
    });
  }
  effectiveOperationLimits(operationId: string) {
    const op = this.operation(operationId);
    if (!op)
      throw new PlatformError("NOT_FOUND", "Operación no encontrada.", 404);
    const policy = this.limitPolicy(op.clientId, op.currency);
    return {
      limits: effectiveLimits(op.limits, policy),
      policyRevision: policy.revision,
      clientMayEdit: policy.clientMayEdit && op.clientMayEditLimits,
    };
  }
  createOperation(
    actor: Admin,
    clientId: string,
    input: Record<string, unknown>,
  ) {
    this.authorize(actor, clientId);
    if (!this.client(clientId))
      throw new PlatformError("NOT_FOUND", "Cliente no encontrado.", 404);
    const name = text(input.name, "operación"),
      country = text(input.country, "país", 2).toUpperCase(),
      code = currency(input.currency);
    if (!/^[A-Z]{2}$/.test(country))
      throw new PlatformError(
        "INVALID_COUNTRY",
        "Ingresá el código de país de dos letras.",
      );
    const policy = this.limitPolicy(clientId, code);
    const clientEdits = input.clientMayEditLimits === true;
    if (input.clientMayEditLimits !== undefined) this.authorize(actor);
    if (
      input.limits !== undefined &&
      actor.role !== "platform_admin" &&
      (!policy.clientMayEdit || !clientEdits)
    )
      throw new PlatformError(
        "LIMIT_EDIT_FORBIDDEN",
        "La plataforma no autorizó la edición de límites.",
        403,
      );
    const limits = validateLimits(input.limits || policy);
    if (!withinPolicy(limits, policy))
      throw new PlatformError(
        "LIMIT_POLICY_EXCEEDED",
        "Los límites superan lo autorizado por la plataforma.",
        403,
      );
    return this.transaction(() => {
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(
          id,
          clientId,
          name,
          country,
          code,
          "active",
          1,
          clientEdits ? 1 : 0,
          JSON.stringify(limits),
          new Date(this.now()).toISOString(),
        );
      this.audit(actor.id, clientId, "operation.created", {
        operationId: id,
        currency: code,
        country,
      });
      return this.operation(id)!;
    });
  }
  updateOperation(
    actor: Admin,
    clientId: string,
    operationId: string,
    input: Record<string, unknown>,
  ) {
    const op = this.authorizeOperation(actor, clientId, operationId);
    const previous = structuredClone(op);
    if (input.currency !== undefined && input.currency !== op.currency)
      throw new PlatformError(
        "OPERATION_CURRENCY_IMMUTABLE",
        "La moneda es fija. Creá otra operación.",
        409,
      );
    assertBinding(op, input);
    if (input.name !== undefined) op.name = text(input.name, "operación");
    if (input.country !== undefined) {
      op.country = text(input.country, "país", 2).toUpperCase();
      if (!/^[A-Z]{2}$/.test(op.country))
        throw new PlatformError("INVALID_COUNTRY", "País inválido.");
    }
    if (input.status !== undefined) {
      if (!["active", "suspended"].includes(String(input.status)))
        throw new PlatformError("INVALID_STATUS", "Estado inválido.");
      op.status = input.status as Operation["status"];
    }
    if (input.acceptingTickets !== undefined) {
      if (typeof input.acceptingTickets !== "boolean")
        throw new PlatformError("INVALID_SETTINGS", "Configuración inválida.");
      op.acceptingTickets = input.acceptingTickets;
    }
    if (input.clientMayEditLimits !== undefined) {
      this.authorize(actor);
      if (typeof input.clientMayEditLimits !== "boolean")
        throw new PlatformError("INVALID_POLICY", "Permiso inválido.");
      op.clientMayEditLimits = input.clientMayEditLimits;
    }
    if (input.limits !== undefined) {
      const policy = this.limitPolicy(clientId, op.currency);
      if (
        actor.role !== "platform_admin" &&
        (!policy.clientMayEdit || !op.clientMayEditLimits)
      )
        throw new PlatformError(
          "LIMIT_EDIT_FORBIDDEN",
          "No tenés permiso para editar los límites de esta operación.",
          403,
        );
      op.limits = validateLimits(input.limits);
      if (!withinPolicy(op.limits, policy))
        throw new PlatformError(
          "LIMIT_POLICY_EXCEEDED",
          "Los límites superan lo autorizado por la plataforma.",
          403,
        );
    }
    return this.transaction(() => {
      this.db
        .prepare(
          "UPDATE operations SET name=?,country=?,status=?,accepting=?,client_edits=?,limits=? WHERE id=?",
        )
        .run(
          op.name,
          op.country,
          op.status,
          op.acceptingTickets ? 1 : 0,
          op.clientMayEditLimits ? 1 : 0,
          JSON.stringify(op.limits),
          op.id,
        );
      this.audit(actor.id, clientId, "operation.updated", {
        operationId: op.id,
        currency: op.currency,
        previous,
        next: op,
      });
      return op;
    });
  }
  credentials(actor: Admin, clientId: string, operationId: string) {
    this.authorizeOperation(actor, clientId, operationId);
    return this.db
      .prepare(
        "SELECT id,name,created,revoked,operation_id as operationId,client_id as clientId,currency FROM operation_credentials WHERE operation_id=? ORDER BY created DESC,rowid DESC",
      )
      .all(operationId);
  }
  issueCredential(
    actor: Admin,
    clientId: string,
    operationId: string,
    name: unknown,
    rotateId?: string,
  ) {
    const op = this.authorizeOperation(actor, clientId, operationId);
    const normalized = text(name, "credencial", 100);
    if (
      rotateId &&
      !this.db
        .prepare(
          "SELECT id FROM operation_credentials WHERE id=? AND operation_id=? AND revoked IS NULL",
        )
        .get(rotateId, op.id)
    )
      throw new PlatformError(
        "NOT_FOUND",
        "Credencial activa no encontrada.",
        404,
      );
    const id = randomUUID(),
      value = `adl_${id}_${token()}`,
      directory = join(this.directory, "credentials");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const path = join(directory, `${id}.key`);
    writeFileSync(path, value, { flag: "wx", mode: 0o600 });
    try {
      return this.transaction(() => {
        this.db
          .prepare(
            "INSERT INTO operation_credentials VALUES(?,?,?,?,?,?,?,NULL)",
          )
          .run(
            id,
            op.id,
            clientId,
            op.currency,
            normalized,
            digest(value),
            new Date(this.now()).toISOString(),
          );
        if (rotateId) this.revokeInternal(op.id, rotateId);
        this.audit(
          actor.id,
          clientId,
          rotateId ? "credential.rotated" : "credential.created",
          {
            operationId: op.id,
            currency: op.currency,
            credentialId: id,
            ...(rotateId ? { replaces: rotateId } : {}),
          },
        );
        return {
          id,
          name: normalized,
          operationId: op.id,
          clientId,
          currency: op.currency,
          delivery: "server_file_only",
          revoked: null,
        };
      });
    } catch (error) {
      unlinkSync(path);
      throw error;
    }
  }
  private revokeInternal(operationId: string, keyId: string) {
    this.db
      .prepare(
        "UPDATE operation_credentials SET revoked=? WHERE id=? AND operation_id=? AND revoked IS NULL",
      )
      .run(new Date(this.now()).toISOString(), keyId, operationId);
    this.db
      .prepare("DELETE FROM operation_sessions WHERE credential_id=?")
      .run(keyId);
    this.db
      .prepare(
        "DELETE FROM operation_embeds WHERE hash IN (SELECT embed_hash FROM operation_embed_keys WHERE credential_id=?)",
      )
      .run(keyId);
    this.db
      .prepare("DELETE FROM operation_embed_keys WHERE credential_id=?")
      .run(keyId);
  }
  revokeCredential(
    actor: Admin,
    clientId: string,
    operationId: string,
    keyId: string,
  ) {
    const op = this.authorizeOperation(actor, clientId, operationId);
    if (
      !this.db
        .prepare(
          "SELECT id FROM operation_credentials WHERE id=? AND operation_id=?",
        )
        .get(keyId, op.id)
    )
      throw new PlatformError("NOT_FOUND", "Credencial no encontrada.", 404);
    this.transaction(() => {
      this.revokeInternal(op.id, keyId);
      this.audit(actor.id, clientId, "credential.revoked", {
        operationId: op.id,
        currency: op.currency,
        credentialId: keyId,
      });
    });
  }
  integration(value: string):
    | (OperationScope & {
        credentialId: string;
        kind: "server" | "iframe";
        playerId?: string;
        channel?: IntegrationChannel;
        terminalId?: string;
      })
    | undefined {
    const key = this.db
      .prepare(
        "SELECT id,client_id,operation_id,currency FROM operation_credentials WHERE hash=? AND revoked IS NULL",
      )
      .get(digest(value)) as
      | {
          id: string;
          client_id: string;
          operation_id: string;
          currency: Currency;
        }
      | undefined;
    if (key)
      return {
        clientId: key.client_id,
        operationId: key.operation_id,
        currency: key.currency,
        credentialId: key.id,
        kind: "server",
      };
    const session = this.db
      .prepare(
        "SELECT s.* FROM operation_sessions s JOIN operation_credentials c ON c.id=s.credential_id WHERE s.hash=? AND s.expires>? AND c.revoked IS NULL",
      )
      .get(digest(value), this.now()) as
      | {
          client_id: string;
          operation_id: string;
          currency: Currency;
          player_id: string;
          credential_id: string;
          channel: IntegrationChannel;
          terminal_id: string | null;
        }
      | undefined;
    if (session?.channel === "pos")
      this.assertTerminal(session.operation_id, session.terminal_id!);
    return session
      ? {
          clientId: session.client_id,
          operationId: session.operation_id,
          currency: session.currency,
          playerId: session.player_id,
          credentialId: session.credential_id,
          channel: session.channel,
          ...(session.terminal_id ? { terminalId: session.terminal_id } : {}),
          kind: "iframe",
        }
      : undefined;
  }
  createEmbed(
    auth: OperationScope & { credentialId: string; kind: string },
    input: Record<string, unknown>,
  ) {
    if (auth.kind !== "server")
      throw new PlatformError(
        "FORBIDDEN",
        "Solo el servidor del casino puede crear sesiones.",
        403,
      );
    assertBinding(auth, input, true);
    const playerId = text(input.playerId, "playerId", 120),
      parentOrigin = origins([input.parentOrigin])[0],
      device = integrationChannel(input.channel, input.terminalId);
    if (device.channel === "pos")
      this.assertTerminal(auth.operationId, device.terminalId!);
    const client = this.client(auth.clientId)!;
    if (!client.domains.includes(parentOrigin))
      throw new PlatformError(
        "DOMAIN_NOT_ALLOWED",
        "Origen no autorizado.",
        403,
      );
    const code = token();
    this.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM operation_embed_keys WHERE embed_hash IN (SELECT hash FROM operation_embeds WHERE expires<=?)",
        )
        .run(this.now());
      this.db
        .prepare("DELETE FROM operation_embeds WHERE expires<=?")
        .run(this.now());
      this.db
        .prepare("DELETE FROM operation_sessions WHERE expires<=?")
        .run(this.now());
      this.db
        .prepare("INSERT INTO operation_embeds VALUES(?,?,?,?,?,?,?,?,?,0)")
        .run(
          digest(code),
          auth.operationId,
          auth.clientId,
          auth.currency,
          playerId,
          parentOrigin,
          device.channel,
          device.terminalId || null,
          this.now() + 60000,
        );
      this.db
        .prepare("INSERT INTO operation_embed_keys VALUES(?,?)")
        .run(digest(code), auth.credentialId);
    });
    return {
      code,
      clientId: auth.clientId,
      operationId: auth.operationId,
      currency: auth.currency,
      expiresIn: 60,
    };
  }
  exchangeEmbed(input: Record<string, unknown>) {
    if (typeof input.code !== "string" || input.code.length > 100)
      throw new PlatformError(
        "INVALID_SESSION",
        "Sesión inválida o vencida.",
        401,
      );
    const code = input.code;
    return this.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT e.*,k.credential_id FROM operation_embeds e JOIN operation_embed_keys k ON k.embed_hash=e.hash JOIN operation_credentials c ON c.id=k.credential_id WHERE e.hash=? AND e.expires>? AND e.consumed=0 AND c.revoked IS NULL",
        )
        .get(digest(code), this.now()) as
        | {
            client_id: string;
            operation_id: string;
            currency: Currency;
            player_id: string;
            parent_origin: string;
            credential_id: string;
            channel: IntegrationChannel;
            terminal_id: string | null;
          }
        | undefined;
      if (
        !row ||
        !this.client(row.client_id)?.domains.includes(row.parent_origin)
      )
        throw new PlatformError(
          "INVALID_SESSION",
          "Sesión inválida o vencida.",
          401,
        );
      if (row.channel === "pos")
        this.assertTerminal(row.operation_id, row.terminal_id!);
      const scope = {
        clientId: row.client_id,
        operationId: row.operation_id,
        currency: row.currency,
      };
      assertBinding(scope, input);
      if (
        input.clientId !== scope.clientId ||
        input.operationId !== scope.operationId
      )
        throw new PlatformError(
          "SCOPE_MISMATCH",
          "Operación de la sesión inválida.",
          403,
        );
      this.db
        .prepare("UPDATE operation_embeds SET consumed=1 WHERE hash=?")
        .run(digest(code));
      const accessToken = token();
      this.db
        .prepare("INSERT INTO operation_sessions VALUES(?,?,?,?,?,?,?,?,?)")
        .run(
          digest(accessToken),
          scope.operationId,
          scope.clientId,
          scope.currency,
          row.player_id,
          row.channel,
          row.terminal_id,
          this.now() + 900000,
          row.credential_id,
        );
      return {
        accessToken,
        expiresIn: 900,
        scope,
        channel: row.channel,
        terminalId: row.terminal_id || undefined,
        operation: this.operation(scope.operationId),
        client: this.client(scope.clientId),
        theme: this.publishedSportsbookTheme(scope.clientId),
      };
    });
  }
  auditEntries(actor: Admin, clientId?: string) {
    this.authorize(actor, clientId);
    return (
      clientId
        ? this.db
            .prepare(
              "SELECT * FROM audit WHERE client_id=? ORDER BY id DESC LIMIT 100",
            )
            .all(clientId)
        : this.db
            .prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 100")
            .all()
    ).map((row) => ({
      id: Number(row.id),
      at: String(row.at),
      actor: String(row.actor),
      client_id: row.client_id === null ? null : String(row.client_id),
      action: String(row.action),
      details: JSON.parse(String(row.details)),
    }));
  }
}
export function existingPlatformDirectory() {
  const directory = platformDirectory();
  return existsSync(join(directory, "control.sqlite")) ? directory : undefined;
}
