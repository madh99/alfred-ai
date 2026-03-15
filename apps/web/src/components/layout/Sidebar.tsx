'use client';

import clsx from 'clsx';

const BASE = '/alfred';

const navItems = [
  { href: `${BASE}/chat/`, label: 'Chat', icon: '💬' },
  { href: `${BASE}/dashboard/`, label: 'Dashboard', icon: '📊' },
  { href: `${BASE}/settings/`, label: 'Settings', icon: '⚙️' },
];

export function Sidebar() {
  // Use window.location for active detection (works with full page loads)
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '';

  return (
    <aside className="w-16 md:w-56 bg-[#111111] border-r border-[#1f1f1f] flex flex-col h-full">
      <div className="p-4 border-b border-[#1f1f1f]">
        <a href={`${BASE}/`} className="flex items-center gap-2">
          <span className="text-xl font-bold text-blue-500 font-mono">A</span>
          <span className="hidden md:inline text-sm font-semibold text-gray-200">Alfred</span>
        </a>
      </div>
      <nav className="flex-1 p-2 space-y-1">
        {navItems.map(({ href, label, icon }) => (
          <a
            key={href}
            href={href}
            className={clsx(
              'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
              pathname.startsWith(href.replace(/\/$/, ''))
                ? 'bg-blue-500/10 text-blue-400'
                : 'text-gray-400 hover:bg-[#1a1a1a] hover:text-gray-200',
            )}
          >
            <span>{icon}</span>
            <span className="hidden md:inline">{label}</span>
          </a>
        ))}
      </nav>
      <div className="p-4 border-t border-[#1f1f1f]">
        <a
          href="https://github.com/madh99/alfred-ai"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-gray-500 hover:text-gray-400 hidden md:block"
        >
          GitHub
        </a>
      </div>
    </aside>
  );
}
