/**
 * MarkdownText — dependency-free markdown renderer for agent replies.
 *
 * Supports the subset Onyx actually emits: headings (#..###), bold, italic,
 * inline code, fenced blocks, links, images (standalone lines become figures),
 * bullet lists, numbered lists. Product images from web_product_search land
 * here as markdown images and render as real <img> elements.
 *
 * Hardened: all hrefs/srcs are sanitized to http(s); javascript:/data: URLs
 * are dropped; text is rendered as React children (no dangerouslySetInnerHTML).
 */
'use client';

import { Fragment, type ReactNode } from 'react';

const IMG_LINE_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const INLINE_RE = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]]+\]\([^)\s]+\)|!\[[^\]]*\]\([^)\s]+\))/g;

function safeUrl(url: string): string | null {
  if (/^https?:\/\//i.test(url)) return url;
  return null;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(INLINE_RE).filter((p) => p !== undefined && p !== '');
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={key} className="font-semibold text-slate-100">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={key} className="rounded bg-slate-950/70 px-1.5 py-0.5 font-mono text-[11px] text-emerald-300">
          {part.slice(1, -1)}
        </code>
      );
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (link) {
      const href = safeUrl(link[2]);
      if (href) {
        return (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-emerald-400 underline decoration-emerald-500/40 hover:decoration-emerald-400"
          >
            {link[1]}
          </a>
        );
      }
      return <Fragment key={key}>{link[1]}</Fragment>;
    }
    const img = part.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (img) {
      const src = safeUrl(img[2]);
      if (src) {
        return (
          <img
            key={key}
            src={src}
            alt={img[1]}
            referrerPolicy="no-referrer"
            loading="lazy"
            className="my-1 max-h-48 rounded-lg border border-slate-700/60"
          />
        );
      }
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

export default function MarkdownText({ text }: { text: string }) {
  const lines = (text ?? '').split('\n');
  const blocks: ReactNode[] = [];
  let listItems: { ordered: boolean; items: string[] } | null = null;

  const flushList = (key: string) => {
    if (!listItems) return;
    const Tag = listItems.ordered ? 'ol' : 'ul';
    blocks.push(
      <Tag
        key={key}
        className={`my-1.5 ml-5 space-y-1 text-sm ${listItems.ordered ? 'list-decimal' : 'list-disc'} marker:text-emerald-500/70`}
      >
        {listItems.items.map((item, i) => (
          <li key={i}>{renderInline(item, `${key}-${i}`)}</li>
        ))}
      </Tag>
    );
    listItems = null;
  };

  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    const key = `ln-${idx}`;

    const imgMatch = line.trim().match(IMG_LINE_RE);
    if (imgMatch) {
      flushList(`list-${idx}`);
      const src = safeUrl(imgMatch[2]);
      if (src) {
        blocks.push(
          <figure key={key} className="my-1.5">
            <img
              src={src}
              alt={imgMatch[1]}
              referrerPolicy="no-referrer"
              loading="lazy"
              className="max-h-56 rounded-xl border border-slate-700/60 bg-slate-950/40 object-contain"
            />
            {imgMatch[1] && <figcaption className="mt-0.5 text-[10px] text-slate-500">{imgMatch[1]}</figcaption>}
          </figure>
        );
      }
      return;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushList(`list-${idx}`);
      const level = heading[1].length;
      const sizes = ['text-base', 'text-sm', 'text-sm', 'text-xs'];
      blocks.push(
        <p key={key} className={`mt-2 font-bold text-slate-100 ${sizes[level - 1]}`}>
          {renderInline(heading[2], key)}
        </p>
      );
      return;
    }

    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      if (!listItems || listItems.ordered !== ordered) {
        flushList(`list-${idx}`);
        listItems = { ordered, items: [] };
      }
      listItems.items.push((bullet ?? numbered)![1]);
      return;
    }

    if (line.trim() === '') {
      flushList(`list-${idx}`);
      return;
    }

    flushList(`list-${idx}`);
    blocks.push(
      <p key={key} className="my-0.5">
        {renderInline(line, key)}
      </p>
    );
  });
  flushList('list-end');

  return <div className="break-words">{blocks}</div>;
}
