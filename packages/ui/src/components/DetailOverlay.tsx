import React from 'react';

export function DetailOverlay({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="absolute inset-0 bg-black/80 z-50 flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/10 bg-white/5">
        <h2 className="text-xs font-bold text-white/90">{title}</h2>
        <button
          onClick={onClose}
          className="text-xs text-white/50 hover:text-white/80 bg-white/10 px-3 py-1 rounded cursor-pointer border border-white/20 hover:border-white/30"
        >
          Close
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">{children}</div>
    </div>
  );
}
