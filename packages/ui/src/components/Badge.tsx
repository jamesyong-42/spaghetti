import React from 'react';

export function Badge({ text, color = 'white/10' }: { text: string; color?: string }) {
  return (
    <span className={`text-[9px] bg-${color} px-1 py-0.5 rounded`}>{text}</span>
  );
}
