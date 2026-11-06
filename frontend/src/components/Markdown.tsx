import { memo, useState, type ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";

/**
 * Renders assistant Markdown safely: raw HTML in the text is NOT rendered
 * (react-markdown escapes it without rehype-raw), and link/image URLs pass
 * through react-markdown's default URL sanitiser, which drops `javascript:` etc.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer nofollow" />,
  // Images from model output could be used to exfiltrate data via URLs, so render them as links instead.
  img: ({ src, alt }) => (
    <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noopener noreferrer nofollow">
      {alt || "image"}
    </a>
  ),
  pre: ({ node: _node, children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ node: _node, ...props }) => (
    <div className="md-table">
      <table {...props} />
    </div>
  ),
};

function CodeBlock({ children }: { children: ComponentProps<"pre">["children"] }) {
  const [copied, setCopied] = useState(false);
  // children is the <code> element; read its language class and text.
  const code = children as { props?: { className?: string; children?: unknown } } | undefined;
  const language = /language-([\w+-]+)/.exec(code?.props?.className ?? "")?.[1];
  const text = String(code?.props?.children ?? "").replace(/\n$/, "");
  return (
    <div className="md-code group/code">
      <div className="md-code-bar">
        <span>{language ?? "code"}</span>
        <button
          type="button"
          aria-label="Copy code"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* clipboard blocked */
            }
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}
