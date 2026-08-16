import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function prettyJson(source: string) {
  try {
    return JSON.stringify(JSON.parse(source), null, 2);
  } catch {
    return null;
  }
}

export function modelMarkdownSource(content: string) {
  const value = content || '';
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) {
    const formatted = prettyJson(fenced[1]);
    return formatted ? `\`\`\`json\n${formatted}\n\`\`\`` : value;
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const formatted = prettyJson(trimmed) || trimmed;
    return `\`\`\`json\n${formatted}\n\`\`\``;
  }
  return value;
}

export function ModelMarkdown({ content, label }: { content: string; label: string }) {
  return <div className="model-markdown" aria-label={label}><ReactMarkdown remarkPlugins={[remarkGfm]}>{modelMarkdownSource(content)}</ReactMarkdown></div>;
}
