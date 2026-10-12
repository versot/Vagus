import type { Root as HtmlRoot } from "hast";
import type { RootContent as MdNode, Root as MdRoot } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

const parser = unified().use(remarkParse).use(remarkGfm);
const converter = unified().use(remarkRehype, { allowDangerousHtml: true });
type Block = { key: string; source: string; tree: HtmlRoot; version: number };
type Cache = { text: string; committed: Block[]; offset: number; blocks: Block[]; global: boolean; revision: number };
const caches = new Map<string, Cache>();
function hasReferences(node: { type: string; children?: unknown[] }): boolean {
  return /^(definition|linkReference|imageReference|footnoteDefinition|footnoteReference)$/.test(node.type) || Boolean(node.children?.some((child) => hasReferences(child as typeof node)));
}
function convert(nodes: MdNode[]) { return converter.runSync({ type: "root", children: nodes } as MdRoot) as unknown as HtmlRoot; }

self.onmessage = ({ data }: MessageEvent<{ id: string; revision: number; text: string; complete: boolean; evict?: string }>) => {
  if (data.evict) { caches.delete(data.evict); return; }
  const started = performance.now();
  try {
    const previous = caches.get(data.id);
    const append = previous && data.text.startsWith(previous.text) && !data.complete;
    const cache: Cache = append ? previous : { text: "", committed: [], offset: 0, blocks: [], global: false, revision: 0 };
    let root = parser.parse(data.text.slice(cache.offset)) as MdRoot;
    cache.global ||= hasReferences(root);
    let blocks: Block[];
    if (cache.global) {
      root = parser.parse(data.text) as MdRoot;
      blocks = [{ key: "document", source: data.text, tree: convert(root.children), version: data.revision }];
      cache.committed = []; cache.offset = 0;
    } else {
      const old = new Map((previous?.blocks ?? cache.blocks).map((block) => [block.key, block]));
      const offset = cache.offset;
      const tail = root.children.map((node) => {
        const start = offset + (node.position?.start.offset ?? 0);
        const end = offset + (node.position?.end.offset ?? data.text.length - offset);
        const source = data.text.slice(start, end);
        const key = `block:${start}`;
        const saved = old.get(key);
        return saved?.source === source ? saved : { key, source, tree: convert([node]), version: data.revision };
      });
      blocks = [...cache.committed, ...tail];
      // Retain two mutable top-level blocks: list continuation, setext headings,
      // tables and unclosed fences can change the last block as text arrives.
      const commitCount = Math.max(0, tail.length - 2);
      if (commitCount) {
        cache.committed = [...cache.committed, ...tail.slice(0, commitCount)];
        cache.offset = offset + (root.children[commitCount]!.position?.start.offset ?? 0);
      }
    }
    const oldVersions = new Map((previous?.blocks ?? []).map((block) => [block.key, block.version]));
    const changes = blocks.filter((block) => oldVersions.get(block.key) !== block.version).map(({ key, version, tree }) => ({ key, version, tree }));
    cache.text = data.text; cache.blocks = blocks; cache.revision = data.revision;
    caches.delete(data.id); caches.set(data.id, cache);
    let size = [...caches.values()].reduce((total, item) => total + item.text.length * 2, 0);
    for (const [id, item] of caches) {
      if (caches.size <= 16 && size <= 8 * 1024 * 1024) break;
      if (id === data.id) continue;
      caches.delete(id); size -= item.text.length * 2;
    }
    self.postMessage({ id: data.id, revision: data.revision, keys: blocks.map((block) => block.key), changes, sourceBytes: data.text.length * 2, elapsedMs: performance.now() - started });
  } catch (error) { self.postMessage({ id: data.id, revision: data.revision, error: String(error) }); }
};
