import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuOption {
  id?: string
  label: string
  shortcut?: string
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
  /** Nested options; when present the item opens a submenu instead of running onClick. */
  children?: ContextMenuOption[]
}

export interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuOption[]
  onClose: () => void
  className?: string
  minWidth?: number
}

export default function ContextMenu({
  x,
  y,
  items,
  onClose,
  className = '',
  minWidth = 140
}: ContextMenuProps): React.ReactElement | null {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: y, left: x })

  useLayoutEffect(() => {
    if (!menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    const padding = 8

    let adjustedX = x
    let adjustedY = y

    if (adjustedX + rect.width > window.innerWidth - padding) {
      adjustedX = Math.max(padding, window.innerWidth - rect.width - padding)
    }

    if (adjustedY + rect.height > window.innerHeight - padding) {
      adjustedY = Math.max(padding, window.innerHeight - rect.height - padding)
    }

    setPos({ top: adjustedY, left: adjustedX })
  }, [x, y, items.length])

  useEffect(() => {
    let active = true

    const handleClickOutside = (event: MouseEvent) => {
      if (!active) return
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose()
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    const timer = setTimeout(() => {
      if (!active) return
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('contextmenu', handleClickOutside)
      document.addEventListener('keydown', handleKeyDown)
    }, 50)

    return () => {
      active = false
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('contextmenu', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  if (!items || items.length === 0) return null

  const content = (
    <div
      ref={menuRef}
      role="menu"
      aria-orientation="vertical"
      className={`fixed z-[9999] bg-card/95 backdrop-blur-md border border-border/80 rounded-lg shadow-xl p-1 select-none animate-in fade-in zoom-in-95 duration-100 ${className}`}
      style={{
        top: `${pos.top}px`,
        left: `${pos.left}px`,
        minWidth: `${minWidth}px`,
        WebkitAppRegion: 'no-drag'
      } as React.CSSProperties}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <MenuItems items={items} onClose={onClose} minWidth={minWidth} />
    </div>
  )

  if (typeof document !== 'undefined') {
    return createPortal(content, document.body)
  }

  return content
}

interface MenuItemsProps {
  items: ContextMenuOption[]
  onClose: () => void
  minWidth: number
}

function MenuItems({ items, onClose, minWidth }: MenuItemsProps): React.ReactElement {
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null)

  return (
    <div className="flex flex-col gap-0.5">
      {items.map((item, idx) => {
        const key = item.id || String(idx)
        const submenuItems = item.children
        const hasChildren = Boolean(submenuItems && submenuItems.length > 0)

        if (item.disabled) {
          return (
            <div
              key={key}
              className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs text-text-muted/40 cursor-not-allowed rounded-md select-none"
            >
              <span className="truncate">{item.label}</span>
              {item.shortcut && (
                <span className="text-[10px] text-text-muted/30 font-mono tracking-wider shrink-0 ml-2">
                  {item.shortcut}
                </span>
              )}
            </div>
          )
        }

        return (
          <div
            key={key}
            className="relative"
            onMouseEnter={() => setOpenSubmenuId(hasChildren ? key : null)}
          >
            <button
              type="button"
              role="menuitem"
              aria-haspopup={hasChildren ? 'menu' : undefined}
              aria-expanded={hasChildren ? openSubmenuId === key : undefined}
              onClick={() => {
                if (hasChildren) {
                  setOpenSubmenuId((current) => (current === key ? null : key))
                  return
                }
                item.onClick?.()
                onClose()
              }}
              className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs text-text hover:bg-input/80 hover:text-accent rounded-md transition-colors cursor-pointer text-left w-full group focus:outline-none focus:bg-input/80 focus:text-accent"
            >
              <span className="truncate">{item.label}</span>
              {item.shortcut && (
                <span className="text-[10px] text-text-muted/60 group-hover:text-accent/80 font-mono tracking-wider shrink-0 ml-2">
                  {item.shortcut}
                </span>
              )}
              {hasChildren && (
                <svg
                  className="w-3 h-3 shrink-0 opacity-60 group-hover:opacity-100"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
              )}
            </button>

            {openSubmenuId === key && submenuItems && submenuItems.length > 0 && (
              <SubmenuPanel items={submenuItems} onClose={onClose} minWidth={minWidth} />
            )}
          </div>
        )
      })}
    </div>
  )
}

interface SubmenuPanelProps {
  items: ContextMenuOption[]
  onClose: () => void
  minWidth: number
}

// Anchored to its parent row and opened to the right; flips sides when a
// viewport edge would clip the panel.
function SubmenuPanel({ items, onClose, minWidth }: SubmenuPanelProps): React.ReactElement {
  const panelRef = useRef<HTMLDivElement>(null)
  const [flipX, setFlipX] = useState(false)
  const [flipY, setFlipY] = useState(false)

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const rect = panel.getBoundingClientRect()
    const padding = 8
    setFlipX(rect.right > window.innerWidth - padding)
    setFlipY(rect.bottom > window.innerHeight - padding)
  }, [])

  return (
    <div
      ref={panelRef}
      role="menu"
      aria-orientation="vertical"
      className={`absolute z-20 ${flipX ? 'right-full mr-1' : 'left-full ml-1'} ${
        flipY ? 'bottom-0' : 'top-0'
      } bg-card/95 backdrop-blur-md border border-border/80 rounded-lg shadow-xl p-1 select-none animate-in fade-in zoom-in-95 duration-100`}
      style={{ minWidth: `${minWidth}px`, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      onClick={(e) => e.stopPropagation()}
    >
      <MenuItems items={items} onClose={onClose} minWidth={minWidth} />
    </div>
  )
}
