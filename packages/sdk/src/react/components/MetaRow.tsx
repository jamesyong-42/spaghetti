import React from 'react';

export function MetaRow({ items }: { items: [string, string | undefined | null][] }) {
  const visible = items.filter(([, v]) => v != null && v !== '' && v !== 'undefined');
  if (visible.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] text-white/20 font-mono mt-0.5">
      {visible.map(([k, v], i) => (
        <span key={i}>
          {k}: {v}
        </span>
      ))}
    </div>
  );
}
