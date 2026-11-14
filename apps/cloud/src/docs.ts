/**
 * 共享上下文里的资料和 skill（协作方案第 4 节、第 9.1 节）。
 *
 * - 资料属于一个空间，或者属于组织层（`space_id` 为空，全员可见）。skill 是一种资料（`kind = skill`），写「这件事怎么做」。
 * - 谁能读：按会话的受众现算，见 `docScope`。范围直接写进查询条件，不查完再筛。
 * - 改一份资料是加一个新版本，旧版本标 `ended_at`，不真删。
 * - page 是一页自带的 HTML（Artifacts），人上传或 Pupu 写的，界面上放进沙箱 iframe 里跑，见 `PAGE_SANDBOX`。
 * - 正文存在这张表里（有长度上限），没放 R2：R2 要在账户里新建桶，等图片和多文件的页面一起做。
 */

import { isOpen, mayRead, maySeeSpace, type AccessThread, type SpaceAccess } from "./access.ts";

export type DocKind = "doc" | "skill" | "page";

export type DocMeta = {
  /** 这份资料的 id，改了也不变。 */
  readonly id: string;
  /** 属于哪个空间。null 是组织层。 */
  readonly spaceId: string | null;
  readonly kind: DocKind;
  readonly title: string;
  /** 一句说明。skill 靠它让 Pupu 判断什么时候用。 */
  readonly summary: string;
  readonly size: number;
  readonly authorId: string | null;
  /** 从哪份资料提升来的（组织层的副本才有）。 */
  readonly copiedFrom: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type Doc = DocMeta & { readonly body: string };

/** 文字资料的正文上限（字）。长文档先分开存。 */
export const DOC_BODY_LIMIT = 200_000;
/** 页面的上限（UTF-8 字节）。Durable Object 的 SQLite 一个值最多 2MB，留点余地。 */
export const PAGE_BODY_LIMIT = 1_500_000;

/**
 * 页面跑在什么样的 iframe 里。没有 allow-same-origin：页面是不透明源，拿不到 App 的 cookie、localStorage 和 DOM，
 * 发到 App 的请求带的 Origin 是 null，`authenticate` 不认。也没有 allow-top-navigation：页面跳不走 App。
 * 弹窗继承这套沙箱（没有 allow-popups-to-escape-sandbox）。
 */
export const PAGE_SANDBOX = "allow-scripts allow-popups allow-modals allow-forms";

/** 正文放不放得下。 */
export function bodyFits(kind: DocKind, body: string): boolean {
  return kind === "page" ? new TextEncoder().encode(body).length <= PAGE_BODY_LIMIT : body.length <= DOC_BODY_LIMIT;
}

/** 看上去是一页 HTML：以 <!doctype html> 或 <html 开头。人上传时用它认页面。 */
export function looksLikePage(body: string): boolean {
  return /^\s*(<!--[\s\S]*?-->\s*)*<(!doctype\s+html|html[\s>])/i.test(body);
}

/** 存着的或者传上来的种类，认不出的当文字资料。 */
export function kindOf(value: unknown): DocKind {
  return value === "skill" || value === "page" ? value : "doc";
}
/** 提示词里最多列这么多 skill。 */
export const SKILL_LIST_LIMIT = 30;

/** 一条会话能读到的资料范围：组织层，加上这些空间。 */
export type DocScope = { readonly spaceIds: readonly string[] };

/**
 * 这条会话能读哪些空间的资料：它能读到的空间（`mayRead`，L4 只有自己的会话），加上组织层。
 * 受众按会话算，所以空间里拉了新人，以后的查询自然就按新受众来。
 */
export function docScope(thread: AccessThread, spaces: readonly (SpaceAccess & { readonly id: string })[]): DocScope {
  return { spaceIds: spaces.filter((space) => mayRead(thread, space)).map((space) => space.id) };
}

/**
 * 人在界面上看资料：组织层，加上他看得到的空间（是成员，或全组织档）。人自己进得了 L4，所以 L4 的也在。
 * 没有成员身份（本机开发没登录）只看全组织档的。
 */
export function viewerScope(viewer: string | null, spaces: readonly (SpaceAccess & { readonly id: string })[]): DocScope {
  return { spaceIds: spaces.filter((space) => maySeeSpace(space, viewer)).map((space) => space.id) };
}

/** 人在界面上传资料能放到哪：组织层，或者他看得到的空间。返回 undefined 是不能放。 */
export function viewerTarget(
  viewer: string | null,
  spaceId: string | null,
  spaces: readonly (SpaceAccess & { readonly id: string })[]
): string | null | undefined {
  if (spaceId === null) return null;
  const space = spaces.find((item) => item.id === spaceId);
  return space && maySeeSpace(space, viewer) ? space.id : undefined;
}

/** 资料能不能提升到组织层：只有全组织档空间里的能，组织层的不用再提升。私有和机密的要主人先把空间开放。 */
export function mayPromote(space: SpaceAccess | undefined): boolean {
  return space !== undefined && isOpen(space.level);
}

/**
 * 人能不能删一份资料：上传的人自己，或者它所在地方的管事的（空间主人；组织层是组织的创建者）。
 * Pupu 写的（没有上传人）只有管事的能删。删不弹确认，删了能从旧版本里找回（只标 ended_at）。
 */
export function mayDeleteDoc(
  doc: Pick<DocMeta, "authorId" | "spaceId">,
  viewer: string | null,
  space: { readonly ownerId: string | null } | undefined,
  creator: boolean
): boolean {
  if (viewer === null) return false;
  if (doc.authorId === viewer) return true;
  return doc.spaceId === null ? creator : space?.ownerId === viewer;
}

type Row = Record<string, SqlStorageValue>;

function toMeta(row: Row): DocMeta {
  return {
    id: String(row.doc_id),
    spaceId: row.space_id === null || row.space_id === undefined ? null : String(row.space_id),
    kind: kindOf(row.kind),
    title: String(row.title),
    summary: String(row.summary ?? ""),
    size: Number(row.size),
    authorId: row.author_id === null || row.author_id === undefined ? null : String(row.author_id),
    copiedFrom: row.copied_from === null || row.copied_from === undefined ? null : String(row.copied_from),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

/** 列表只要这些，不把正文（页面可能上 MB）读出来。 */
const META_COLUMNS = "doc_id, space_id, kind, title, summary, size, author_id, copied_from, created_at, updated_at";

/** `space_id IN (…) OR space_id IS NULL`，和它的参数。 */
function scopeWhere(scope: DocScope): { sql: string; params: string[] } {
  if (scope.spaceIds.length === 0) return { sql: "space_id IS NULL", params: [] };
  return { sql: `(space_id IS NULL OR space_id IN (${scope.spaceIds.map(() => "?").join(", ")}))`, params: [...scope.spaceIds] };
}

export class DocStore {
  readonly #sql: SqlStorage;
  #ready = false;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  #db(): SqlStorage {
    if (!this.#ready) {
      // 一行是一个版本：doc_id 不变，version 每改一次新起一个。现行版本 ended_at 为空。
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_docs (
        version TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        space_id TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL,
        size INTEGER NOT NULL,
        author_id TEXT,
        from_session TEXT,
        copied_from TEXT,
        operation TEXT UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ended_at INTEGER
      )`);
      this.#sql.exec("CREATE INDEX IF NOT EXISTS pupu_docs_current ON pupu_docs (doc_id, ended_at)");
      this.#ready = true;
    }
    return this.#sql;
  }

  /** 范围里的现行资料，最近改的在前。`kind` 不给是全部。 */
  list(scope: DocScope, kind?: DocKind): DocMeta[] {
    const where = scopeWhere(scope);
    const kindSql = kind ? " AND kind = ?" : "";
    return this.#db()
      .exec(
        `SELECT ${META_COLUMNS} FROM pupu_docs WHERE ended_at IS NULL AND ${where.sql}${kindSql} ORDER BY updated_at DESC`,
        ...where.params,
        ...(kind ? [kind] : [])
      )
      .toArray()
      .map(toMeta);
  }

  /** 按标题、说明和正文找。 */
  search(scope: DocScope, query: string, limit = 10): DocMeta[] {
    const where = scopeWhere(scope);
    const like = `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    return this.#db()
      .exec(
        `SELECT ${META_COLUMNS} FROM pupu_docs WHERE ended_at IS NULL AND ${where.sql}
         AND (title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')
         ORDER BY updated_at DESC LIMIT ?`,
        ...where.params,
        like,
        like,
        like,
        limit
      )
      .toArray()
      .map(toMeta);
  }

  /** 读一份现行资料。不在范围里的和不存在一样。 */
  read(scope: DocScope, id: string): Doc | undefined {
    const where = scopeWhere(scope);
    const [row] = this.#db()
      .exec(`SELECT * FROM pupu_docs WHERE ended_at IS NULL AND doc_id = ? AND ${where.sql}`, id, ...where.params)
      .toArray();
    return row ? { ...toMeta(row), body: String(row.body) } : undefined;
  }

  /** 不看范围，按 id 拿现行版本。只给已经判断过权限的地方用。 */
  current(id: string): Doc | undefined {
    const [row] = this.#db().exec("SELECT * FROM pupu_docs WHERE ended_at IS NULL AND doc_id = ?", id).toArray();
    return row ? { ...toMeta(row), body: String(row.body) } : undefined;
  }

  /**
   * 写一份资料。给了 `id` 就是改：旧版本标结束，新版本接上，空间和种类不变。
   * `operation` 去重：同一次工具调用重放不会多写一版。
   */
  write(
    input: {
      readonly id?: string;
      readonly spaceId: string | null;
      readonly kind: DocKind;
      readonly title: string;
      readonly summary: string;
      readonly body: string;
      readonly authorId: string | null;
      readonly fromSession: string | null;
      readonly copiedFrom?: string | null;
      readonly operation: string;
    },
    now: number
  ): DocMeta {
    const db = this.#db();
    const [done] = db.exec("SELECT * FROM pupu_docs WHERE operation = ?", input.operation).toArray();
    if (done) return toMeta(done);
    const previous = input.id ? this.current(input.id) : undefined;
    const docId = previous?.id ?? crypto.randomUUID();
    if (previous) db.exec("UPDATE pupu_docs SET ended_at = ? WHERE doc_id = ? AND ended_at IS NULL", now, docId);
    db.exec(
      `INSERT INTO pupu_docs (version, doc_id, space_id, kind, title, summary, body, size, author_id, from_session, copied_from, operation, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      docId,
      previous ? previous.spaceId : input.spaceId,
      previous ? previous.kind : input.kind,
      input.title,
      input.summary,
      input.body,
      new TextEncoder().encode(input.body).length,
      input.authorId,
      input.fromSession,
      input.copiedFrom ?? previous?.copiedFrom ?? null,
      input.operation,
      previous?.createdAt ?? now,
      now
    );
    return this.current(docId)!;
  }

  /** 删一份资料：现行版本标结束。 */
  end(id: string, now: number): boolean {
    return this.#db().exec("UPDATE pupu_docs SET ended_at = ? WHERE doc_id = ? AND ended_at IS NULL", now, id).rowsWritten > 0;
  }
}
