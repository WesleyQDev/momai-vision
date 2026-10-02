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

// Anchored to its parent row with screen-clamped offsets to guarantee
// it is immediately visible and never cut off by viewport boundaries.
function SubmenuPanel({ items, onClose, minWidth }: SubmenuPanelProps): React.ReactElement {
  const panelRef = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<React.CSSProperties>({
    position: 'absolute',
    left: '100%',
    top: 0,
    marginLeft: '4px'
  })

  useLayoutEffect(() => {
    const panel = panelRef.current
    // The panel is rendered inside its row, so the row is the parent element.
    const rowEl = panel?.parentElement
    if (!panel || !rowEl) return
    const rowRect = rowEl.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    const padding = 8

    // Preferred screen X: to the right of parent row
    let targetScreenX = rowRect.right + 4
    if (targetScreenX + panelRect.width > window.innerWidth - padding) {
      // Try to the left of parent row
      targetScreenX = rowRect.left - panelRect.width - 4
    }
    // Clamp to viewport
    targetScreenX = Math.max(padding, Math.min(window.innerWidth - panelRect.width - padding, targetScreenX))

    // Preferred screen Y: aligned with top of parent row
    let targetScreenY = rowRect.top
    if (targetScreenY + panelRect.height > window.innerHeight - padding) {
      targetScreenY = Math.max(padding, window.innerHeight - panelRect.height - padding)
    }

    // Convert absolute screen coordinates into offsets relative to parent row
    const offsetX = targetScreenX - rowRect.left
    const offsetY = targetScreenY - rowRect.top

    setStyle({
      position: 'absolute',
      left: `${offsetX}px`,
      top: `${offsetY}px`,
      minWidth: `${minWidth}px`,
      WebkitAppRegion: 'no-drag'
    } as React.CSSProperties)
  }, [minWidth])

  return (
    <div
      ref={panelRef}
      role="menu"
      aria-orientation="vertical"
      className="z-50 bg-card/95 backdrop-blur-md border border-border/80 rounded-lg shadow-xl p-1 select-none animate-in fade-in zoom-in-95 duration-100"
      style={style}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <MenuItems items={items} onClose={onClose} minWidth={minWidth} />
    </div>
  )
}
